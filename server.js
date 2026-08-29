'use strict';
/**
 * server.js —— Agnes Video 任务控制台 服务端入口
 * Express + SQLite + 后台轮询器 + 静态前端
 */
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const express = require('express');
const { settings, tasks, projects, renders, tx, DEFAULT_SETTINGS, DB_PATH, acquireInstanceLock, instanceLockHeldByOther, refreshInstanceLock } = require('./db');
const agnes = require('./agnes');
const fishTts = require('./fish-tts');
const netmusic = require('./netmusic');
const poller = require('./poller');
const submitter = require('./submitter');
const renderer = require('./render');
const { ARTIFACTS_DIR, downloadArtifact } = require('./artifacts');
const { createPipelineService } = require('./pipeline');
const { buildOpenApi } = require('./openapi');
const { log, recent: recentLogs } = require('./logger');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------------- 常量 ---------------- */

// 模型单一事实来源：前端下拉/提示文案全部经 GET /api/meta 由此渲染
const MODELS = {
  'agnes-video-2.5-flash': {
    family: 'v25', sizes: ['720P'], free: true, short: 'Flash',
    hint: '限时免费 · 仅 720P · reference 最多 5 张图片 · 不支持视频参考',
    label: 'Agnes Video 2.5 Flash（最新 · 免费）',
    rate_limit: '1 次创建/分钟（免费档限流，提交已由服务端队列自动节流）',
  },
  'agnes-video-2.5': {
    family: 'v25', sizes: ['720P', '960P', '2K'], free: false, short: '2.5',
    hint: '付费 · 720P/960P/2K · 支持视频参考',
    label: 'Agnes Video 2.5（付费）',
    rate_limit: '以账户配额为准',
  },
  'agnes-video-v2.0': {
    family: 'v2', sizes: [], free: true, short: 'V2.0（旧）', deprecated: true,
    hint: '旧模型 · 已从界面下架（后端兼容保留）',
    label: 'Agnes Video V2.0（旧模型 · 下架）',
    rate_limit: null,
  },
};
const MODES = ['text', 'keyframe', 'reference'];
const V2_MODES = ['text', 'image', 'keyframes'];
const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const SECONDS_OK = Array.from({ length: 9 }, (_, i) => String(i + 4)); // '4'..'12'
const PROJECT_STATUSES = ['draft', 'copy_done', 'character_done', 'video_submitted'];
const SCRIPT_KINDS = ['script', 'video_prompt', 'character_desc', 'scene_desc'];
const SHOT_COUNTS = ['auto', '3', '5', '8'];   // 分镜生成可选镜头数
const SHOT_MODES = ['reference', 'text'];      // 镜头模式（keyframe 为 M2+ 预留）
const MAX_SHOTS = 20;                          // 每项目镜头数上限

/* 流水线模型（最新免费三件套，M1 固定值） */
const LLM_MODEL = 'agnes-2.5-flash';        // 文本：提示词优化/文案
const IMAGE_MODEL = 'agnes-image-2.1-flash'; // 图片：角色/场景
const IMAGE_SIZES = ['1K', '2K', '3K', '4K'];
const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/* 输入上限 */
const MAX_TEXT_LEN = 8000;       // 提示词/创意/文案等长文本上限
const MAX_MESSAGES = 20;         // /api/llm/chat 消息条数上限
const MAX_INPUT_IMAGES = 5;      // 图片生成输入图上限

/* ---------------- 工具函数 ---------------- */

/** 简单 URL 校验（必须 http/https） */
function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
}

/** 只接受 http(s) 的外部地址，其余（含 javascript: 等异常 scheme）一律置 null */
function safeUrl(u) {
  return isHttpUrl(u) ? String(u).trim() : null;
}

function cleanUrlList(arr, label) {
  if (arr === undefined || arr === null || arr === '') return [];
  if (!Array.isArray(arr)) throw new ApiError(400, `${label} 必须是数组`);
  return arr
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean)
    .map((u) => {
      if (!isHttpUrl(u)) throw new ApiError(400, `${label} 含非法 URL：${u}（必须是可公开访问的 http(s) 地址）`);
      return u;
    });
}

/** videos 支持字符串 URL 或 {url, start_seconds?, require_audio?} 对象 */
function cleanVideoList(arr) {
  if (arr === undefined || arr === null || arr === '') return [];
  if (!Array.isArray(arr)) throw new ApiError(400, 'videos 必须是数组');
  return arr
    .map((v) => {
      if (typeof v === 'string') return { url: v.trim(), start_seconds: 0, require_audio: false };
      if (v && typeof v === 'object' && typeof v.url === 'string') {
        return {
          url: v.url.trim(),
          start_seconds: Number.isFinite(Number(v.start_seconds)) ? Number(v.start_seconds) : 0,
          require_audio: Boolean(v.require_audio),
        };
      }
      throw new ApiError(400, 'videos 元素必须是 URL 字符串或 {url, start_seconds?, require_audio?} 对象');
    })
    .map((v) => {
      if (!isHttpUrl(v.url)) throw new ApiError(400, `videos 含非法 URL：${v.url}`);
      return v;
    });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Express 4 async 路由包装：让 reject / 同步抛出都进入错误中间件 */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * agnes-video-v2.0 参数构建（对照官方文档）
 * 模式：text（文生）/ image（图生，单图）/ keyframes（关键帧，extra_body.image 数组）
 * 时长由 num_frames / frame_rate 决定；尺寸由 width/height 决定（服务端会标准化到 480p/720p/1080p）
 */
function buildV2Payload(b) {
  const model = 'agnes-video-v2.0';
  const prompt = String(b.prompt || '').trim();
  if (!prompt) throw new ApiError(400, 'prompt 不能为空');

  const mode = b.mode !== undefined ? String(b.mode) : 'text';
  if (!V2_MODES.includes(mode)) throw new ApiError(400, `${model} mode 仅支持 ${V2_MODES.join('/')}，收到：${mode}`);

  let numFrames = Number(b.num_frames ?? 121);
  if (!Number.isInteger(numFrames) || numFrames < 9 || numFrames > 441) {
    throw new ApiError(400, `num_frames 必须为 9–441 的整数（如 81/121/241/441），收到：${b.num_frames}`);
  }
  if ((numFrames - 1) % 8 !== 0) {
    throw new ApiError(400, `num_frames 必须满足 8n+1 规则（如 81/121/241/441），收到：${numFrames}`);
  }

  const frameRate = Number(b.frame_rate ?? 24);
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 60) {
    throw new ApiError(400, `frame_rate 需在 1–60 之间，收到：${b.frame_rate}`);
  }

  const seed = b.seed === undefined || b.seed === null || b.seed === '' ? null : Number(b.seed);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0)) throw new ApiError(400, 'seed 必须是非负整数');

  const width = b.width === undefined || b.width === null || b.width === '' ? null : Number(b.width);
  const height = b.height === undefined || b.height === null || b.height === '' ? null : Number(b.height);
  for (const [k, v] of [['width', width], ['height', height]]) {
    if (v !== null && (!Number.isInteger(v) || v <= 0)) throw new ApiError(400, `${k} 必须为正整数`);
  }
  const negativePrompt = b.negative_prompt ? String(b.negative_prompt).trim() : '';

  const payload = { model, prompt, num_frames: numFrames, frame_rate: frameRate };
  if (seed !== null) payload.seed = seed;
  if (width !== null && height !== null) {
    payload.width = width;
    payload.height = height;
  }
  if (negativePrompt) payload.negative_prompt = negativePrompt;

  let imageUrl = '';
  const images = [];
  if (mode === 'text') {
    const hasMedia = (b.image && String(b.image).trim()) || (Array.isArray(b.images) && b.images.length);
    if (hasMedia) throw new ApiError(400, 'v2.0 文生视频模式不允许携带图片（image / images）');
  } else if (mode === 'image') {
    imageUrl = String(b.image || '').trim();
    if (!isHttpUrl(imageUrl)) throw new ApiError(400, '图生视频模式需要提供可公开访问的 image URL');
    payload.image = imageUrl;
  } else { // keyframes
    const frames = cleanUrlList(b.images, '关键帧图片');
    if (frames.length < 2) throw new ApiError(400, '关键帧动画至少需要 2 张关键帧图片 URL');
    payload.extra_body = { image: frames, mode: 'keyframes' };
    images.push(...frames);
  }

  const seconds = String((numFrames / frameRate).toFixed(2));
  let aspectRatio = null;
  if (width !== null && height !== null) {
    const g = gcd(width, height);
    aspectRatio = `${width / g}:${height / g}`;
  }
  const sizeStr = width !== null && height !== null ? `${width}x${height}` : null;

  return {
    payload,
    meta: {
      model, mode, prompt, seconds, size: sizeStr, aspect_ratio: aspectRatio, seed,
      image: imageUrl, images, num_frames: numFrames, frame_rate: frameRate,
      width, height, negative_prompt: negativePrompt || null,
    },
  };
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

/** 校验并构建提交给 API 的请求体（按模型家族分发） */
function buildPayload(body) {
  const b = body || {};
  const model = MODELS[b.model] ? b.model : settings.get('model', DEFAULT_SETTINGS.model);
  const info = MODELS[model];
  if (!info) throw new ApiError(400, `不支持的模型：${model}`);
  if (info.family === 'v2') return buildV2Payload({ ...b, model });
  return buildV25Payload(b);
}

function buildV25Payload(b) {
  const model = b.model && MODELS[b.model] ? b.model : settings.get('model', DEFAULT_SETTINGS.model);
  const info = MODELS[model];
  const prompt = String(b.prompt || '').trim();
  if (!prompt) throw new ApiError(400, 'prompt 不能为空');
  const mode = b.mode !== undefined ? String(b.mode) : 'text';
  if (!MODES.includes(mode)) throw new ApiError(400, `mode 仅支持 ${MODES.join('/')}，收到：${mode}`);
  const seconds = String(b.seconds ?? '5');
  if (seconds && !SECONDS_OK.includes(seconds)) throw new ApiError(400, `seconds 仅支持 "4"–"12"，收到：${seconds}`);
  const size = String(b.size || info.sizes[0]);
  if (!info.sizes.includes(size)) {
    throw new ApiError(400, `模型 ${model} 的 size 仅支持 ${info.sizes.join('/')}，收到：${size}`);
  }
  const aspectRatio = String(b.aspect_ratio || '16:9');
  if (!ASPECT_RATIOS.includes(aspectRatio)) {
    throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}，收到：${aspectRatio}`);
  }
  const seed = b.seed === undefined || b.seed === null || b.seed === '' ? null : Number(b.seed);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0)) throw new ApiError(400, 'seed 必须是非负整数');

  const firstFrame = b.first_frame ? String(b.first_frame).trim() : '';
  const lastFrame = b.last_frame ? String(b.last_frame).trim() : '';
  const images = cleanUrlList(b.images, 'images');
  const audios = cleanUrlList(b.audios, 'audios');
  const videos = cleanVideoList(b.videos);

  // 模式规则校验（对齐官方文档）
  switch (mode) {
    case 'text':
      if (firstFrame || lastFrame || images.length || audios.length || videos.length) {
        throw new ApiError(400, 'text 模式不允许携带任何媒体字段（first_frame/last_frame/images/audios/videos）');
      }
      break;
    case 'keyframe':
      if (!firstFrame && !lastFrame) throw new ApiError(400, 'keyframe 模式需要 first_frame 与 last_frame 至少一个');
      if (firstFrame && !isHttpUrl(firstFrame)) throw new ApiError(400, 'first_frame 必须是可公开访问的 URL');
      if (lastFrame && !isHttpUrl(lastFrame)) throw new ApiError(400, 'last_frame 必须是可公开访问的 URL');
      if (images.length || audios.length || videos.length) {
        throw new ApiError(400, 'keyframe 模式不允许携带 images/audios/videos');
      }
      break;
    case 'reference': {
      if (!images.length && !audios.length && !videos.length) {
        throw new ApiError(400, 'reference 模式需要 images / audios / videos 至少提供一类素材');
      }
      if (model === 'agnes-video-2.5-flash' && videos.length) {
        throw new ApiError(400, 'Flash 模型不支持 reference 视频输入（videos is not supported）');
      }
      if (model === 'agnes-video-2.5-flash' && images.length > 5) {
        throw new ApiError(400, 'Flash 模型 images 最多 5 张（images length must not exceed 5）');
      }
      if (firstFrame || lastFrame) throw new ApiError(400, 'reference 模式不允许携带 first_frame/last_frame');
      break;
    }
  }

  const payload = { model, prompt, mode, seconds, size, aspect_ratio: aspectRatio, n: 1 };
  if (seed !== null) payload.seed = seed;
  if (mode === 'keyframe') {
    if (firstFrame) payload.first_frame = firstFrame;
    if (lastFrame) payload.last_frame = lastFrame;
  }
  if (mode === 'reference') {
    if (images.length) payload.images = images;
    if (audios.length) payload.audios = audios;
    if (videos.length) payload.videos = videos; // 已是 {url, start_seconds, require_audio} 对象
  }
  return {
    payload,
    meta: {
      model, mode, prompt, seconds, size, aspect_ratio: aspectRatio, seed,
      first_frame: firstFrame, last_frame: lastFrame, images, audios, videos,
    },
  };
}

/** 创建任务记录并进入提交队列（v1.3）：
 * 不再同步调用上游 —— 由后台提交器（submitter.js）按 submit_interval_ms 节流提交，
 * 429 / 网络错误自动退避重试，把「限流撞墙」变成「排队等待」。 */
async function submitTask(payload, meta, opts = {}) {
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');

  const id = tasks.insert({
    status: 'queued', ...meta, request_json: payload,
    project_id: opts.project_id || null,
    shot_id: opts.shot_id || null,
    text_id: opts.text_id || null,
    image_id: opts.image_id || null,
  });
  submitter.kick(id); // 立即唤醒提交器尝试首次提交（是否放行仍受最小间隔约束）
  log('info', `任务 #${id} 已入队（${meta.model}，后台提交器按间隔提交，429 自动重试）`);
  return tasks.get(id);
}

/* 流水线服务层（镜头/项目视频提交编排，M2） */
const pipeline = createPipelineService({ projects, buildPayload, submitTask, ApiError, log });

/* ---------------- API 路由 ---------------- */

// 前端元数据：模型/画幅/时长的单一事实来源，下拉与提示文案全部由此渲染
app.get('/api/meta', (req, res) => {
  res.json({
    models: Object.entries(MODELS).map(([id, m]) => ({
      id,
      label: m.label,
      short: m.short,
      hint: m.hint,
      free: Boolean(m.free),
      deprecated: Boolean(m.deprecated),
      sizes: m.sizes || [],
      video_ref: id !== 'agnes-video-2.5-flash' && m.family === 'v25',
      max_images: id === 'agnes-video-2.5-flash' ? 5 : null,
      rate_limit: m.rate_limit || null, // v1.3：上游限流提示（前端展示与服务端节流同源）
    })),
    aspect_ratios: ASPECT_RATIOS,
    seconds: SECONDS_OK,
    image: { model: IMAGE_MODEL, sizes: IMAGE_SIZES, ratios: IMAGE_RATIOS },
    llm_model: LLM_MODEL,
  });
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'agnes-video-console', uptime_s: Math.round(process.uptime()), db: DB_PATH, node: process.version });
});

// API 自描述（v1.3）：机器可读的端点文档，自动化脚本 / Agent 无需读源码即可对接
app.get('/api/openapi.json', (req, res) => {
  res.json(buildOpenApi(`${req.protocol}://${req.get('host') || '127.0.0.1:8273'}`));
});

// 获取设置（API Key 永远只返回掩码）
app.get('/api/settings', (req, res) => {
  const key = settings.get('api_key', '');
  const fish = settings.get('fish_api_key', '');
  res.json({
    api_key_set: Boolean(key),
    api_key_masked: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : '',
    base_url: settings.get('base_url', DEFAULT_SETTINGS.base_url),
    model: settings.get('model', DEFAULT_SETTINGS.model),
    poll_interval_ms: Number(settings.get('poll_interval_ms', DEFAULT_SETTINGS.poll_interval_ms)),
    max_active_minutes: Number(settings.get('max_active_minutes', DEFAULT_SETTINGS.max_active_minutes)),
    submit_interval_ms: Number(settings.get('submit_interval_ms', DEFAULT_SETTINGS.submit_interval_ms)),
    // TTS（Fish Audio）
    fish_api_key_set: Boolean(fish),
    fish_api_key_masked: fish ? `${fish.slice(0, 6)}****${fish.slice(-4)}` : '',
    fish_voice: settings.get('fish_voice', DEFAULT_SETTINGS.fish_voice),
    fish_speed: Number(settings.get('fish_speed', DEFAULT_SETTINGS.fish_speed)),
    // BGM（v1.4 音乐接口）
    music_api_base: settings.get('music_api_base', DEFAULT_SETTINGS.music_api_base),
    music_api_token_set: Boolean(settings.get('music_api_token', '')),
    music_level: settings.get('music_level', DEFAULT_SETTINGS.music_level),
  });
});

// 更新设置
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const changed = [];
  if (b.api_key !== undefined) {
    const k = String(b.api_key).trim();
    if (k) {
      settings.set('api_key', k);
      changed.push('api_key');
    }
  }
  if (b.base_url !== undefined) {
    if (!isHttpUrl(b.base_url)) throw new ApiError(400, 'base_url 必须是 http(s) 地址');
    settings.set('base_url', agnes.normalizeBaseUrl(b.base_url));
    changed.push('base_url');
  }
  if (b.model !== undefined) {
    if (!MODELS[b.model]) throw new ApiError(400, `不支持的模型：${b.model}`);
    settings.set('model', b.model);
    changed.push('model');
  }
  if (b.poll_interval_ms !== undefined) {
    const ms = Number(b.poll_interval_ms);
    if (!Number.isFinite(ms) || ms < 500 || ms > 30000) throw new ApiError(400, 'poll_interval_ms 需在 500–30000ms 之间');
    settings.set('poll_interval_ms', String(Math.round(ms)));
    changed.push('poll_interval_ms');
  }
  if (b.max_active_minutes !== undefined) {
    const m = Number(b.max_active_minutes);
    if (!Number.isFinite(m) || m < 1 || m > 1440) throw new ApiError(400, 'max_active_minutes 需在 1–1440 之间');
    settings.set('max_active_minutes', String(Math.round(m)));
    changed.push('max_active_minutes');
  }
  if (b.submit_interval_ms !== undefined) {
    const ms = Number(b.submit_interval_ms);
    if (!Number.isInteger(ms) || ms < 0 || ms > 300000) throw new ApiError(400, 'submit_interval_ms 需为 0–300000 的整数（0 = 连续提交）');
    settings.set('submit_interval_ms', String(ms));
    changed.push('submit_interval_ms');
  }
  // TTS 设置（Fish Audio）
  if (b.fish_api_key !== undefined) {
    const k = String(b.fish_api_key).trim();
    if (k) { settings.set('fish_api_key', k); changed.push('fish_api_key'); }
    else if (b.fish_api_key === '') { settings.set('fish_api_key', ''); changed.push('fish_api_key'); }
  }
  if (b.clear_fish_api_key === true) { settings.set('fish_api_key', ''); changed.push('fish_api_key'); }
  if (b.fish_voice !== undefined) {
    const v = String(b.fish_voice).trim().slice(0, 100);
    if (v) { settings.set('fish_voice', v); changed.push('fish_voice'); }
  }
  if (b.fish_speed !== undefined) {
    const sp = Number(b.fish_speed);
    if (!Number.isFinite(sp) || sp < 0.5 || sp > 2) throw new ApiError(400, 'fish_speed 需在 0.5–2.0 之间');
    settings.set('fish_speed', String(sp));
    changed.push('fish_speed');
  }
  // BGM 音乐接口设置（v1.4）
  if (b.music_api_base !== undefined) {
    const u = String(b.music_api_base).trim().replace(/\/+$/, '');
    if (u && !isHttpUrl(u)) throw new ApiError(400, 'music_api_base 必须是 http(s) 地址');
    settings.set('music_api_base', u);
    changed.push('music_api_base');
  }
  if (b.music_api_token !== undefined) {
    const t = String(b.music_api_token).trim();
    if (t) { settings.set('music_api_token', t); changed.push('music_api_token'); }
    else if (b.music_api_token === '') { settings.set('music_api_token', ''); changed.push('music_api_token'); }
  }
  if (b.clear_music_api_token === true) { settings.set('music_api_token', ''); changed.push('music_api_token'); }
  if (b.music_level !== undefined) {
    const lv = String(b.music_level).trim();
    if (!netmusic.LEVELS.includes(lv)) throw new ApiError(400, `music_level 仅支持 ${netmusic.LEVELS.join('/')}`);
    settings.set('music_level', lv);
    changed.push('music_level');
  }
  if (b.clear_api_key === true) settings.set('api_key', '');
  if (changed.includes('poll_interval_ms') || !poller.timer) poller.start();
  log('info', `设置已更新: ${changed.join(', ') || '无'}`);
  res.json({ ok: true, changed });
});

// 统计
app.get('/api/stats', (req, res) => res.json(tasks.stats()));

// 任务列表（过滤 + 搜索 + 分页）
app.get('/api/tasks', (req, res) => {
  const { status, q, limit, offset } = req.query;
  res.json({
    items: tasks.list({
      status: ['queued', 'in_progress', 'completed', 'failed', 'submit_error'].includes(status) ? status : null,
      q: q ? String(q).slice(0, 200) : null,
      limit,
      offset,
    }),
    stats: tasks.stats(),
  });
});

// 创建任务
app.post('/api/tasks', ah(async (req, res) => {
  const { payload, meta } = buildPayload(req.body);
  const task = await submitTask(payload, meta);
  res.status(201).json(task);
}));

// 查询单个任务
app.get('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) throw new ApiError(404, '任务不存在');
  res.json(t);
});

// 重试（以原参数创建新任务，保留失败记录便于审计）
app.post('/api/tasks/:id/retry', ah(async (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) throw new ApiError(404, '任务不存在');
  if (!['failed', 'submit_error'].includes(t.status)) {
    throw new ApiError(400, `仅 failed / submit_error 状态可重试，当前状态：${t.status}`);
  }
  const meta = {
    model: t.model, mode: t.mode, prompt: t.prompt, seconds: t.seconds,
    size: t.size, aspect_ratio: t.aspect_ratio, seed: t.seed,
    first_frame: t.first_frame, last_frame: t.last_frame,
    images: t.images, audios: t.audios, videos: t.videos,
    image: t.image, num_frames: t.num_frames, frame_rate: t.frame_rate,
    width: t.width, height: t.height, negative_prompt: t.negative_prompt,
  };
  const { payload } = buildPayload(meta);
  const task = await submitTask(payload, meta);
  log('info', `任务 #${t.id} 重试 → 新任务 #${task.id}`);
  res.status(201).json({ old: t, task });
}));

// 立即强制轮询
app.post('/api/tasks/:id/poll', ah(async (req, res) => {
  try {
    const status = await poller.pollNow(req.params.id);
    res.json({ ok: true, status });
  } catch (e) {
    throw new ApiError(e.message === '任务不存在' ? 404 : 400, e.message);
  }
}));

// 删除任务
// 删除任务记录（若某镜头的定稿 take 引用它，则清引用回退自动模式）
app.delete('/api/tasks/:id', (req, res) => {
  if (!tasks.remove(req.params.id)) throw new ApiError(404, '任务不存在');
  projects.clearShotTakeByTask(Number(req.params.id));
  res.json({ ok: true });
});

// 批量操作
app.post('/api/tasks/bulk/clear-completed', (req, res) => {
  const n = tasks.clearCompleted();
  res.json({ ok: true, removed: n });
});
app.post('/api/tasks/bulk/clear-failed', (req, res) => {
  const failed = tasks.list({ status: 'failed', limit: 500 });
  const fe = tasks.list({ status: 'submit_error', limit: 500 });
  const n = tx(() => {
    let c = 0;
    for (const t of [...failed, ...fe]) if (tasks.remove(t.id)) c++;
    return c;
  });
  res.json({ ok: true, removed: n });
});

// 日志（内存环形缓冲）
app.get('/api/logs', (req, res) => res.json({ items: recentLogs(200) }));

/* ================= 创作流水线（M1：文本 / 图片 / 项目） ================= */

/** 容错解析 LLM 输出 JSON：剥 markdown 围栏 → 提取首个平衡对象 → JSON.parse */
function parseLLMJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 去掉 ```json ... ``` 围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* 继续尝试提取对象 */ }
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 文案生成系统提示词：严格输出结构化 JSON（mock 测试按「JSON 对象」契约标记识别） */
const SCRIPT_SYSTEM_PROMPT = `你是资深影视导演兼 AI 视频提示词工程师。根据用户创意，产出可直接驱动 AI 视频生成的专业文案。
只输出一个 JSON 对象（不要 markdown 代码块、不要注释、不要任何解释），字段如下：
{
  "script": "故事梗概，100~150 字。结构：一句话交代主角与目标 → 两句冲突与转折 → 一句情绪落点。必须用具象画面与动作叙述，禁止「展现了」「体现了」这类抽象概括",
  "video_prompt": "视频生成提示词，150~220 字，六段式按序书写：①主体与场景（谁、在哪、外观关键特征）②动作与变化（2~3 个有先后顺序的连续动作）③镜头语言（景别：特写/中景/全景 + 运镜：推/拉/摇/移/跟 + 转场方式）④光线与色调（时段、光源方向、色温冷暖）⑤视觉风格与画质（写实/胶片/动漫等 + 高细节、电影感等关键词）⑥声音与节奏（环境声、关键音效点、节奏快慢）。必须以「以 <Picture 1> 中的角色为参考，保持其外观一致」开头。每句都要具体可拍摄，禁止堆砌抽象形容词",
  "character_desc": "主角外观设定（供 AI 角色立绘生成），120 字内，必含：性别年龄、发型发色、五官特征、表情气质、服装款式与颜色、体型、有辨识度的配饰。不要写与场景、剧情相关的内容",
  "scene_desc": "主场景描述，100 字内：地点类型、时段与光源、天气、色调氛围、一处标志性陈设或地物"
}
自洽性要求：character_desc 与 video_prompt 中的角色外观一致；scene_desc 与 script 的时空一致；video_prompt 的动作量与目标时长匹配（5 秒最多 2~3 个动作）。`;

/** 分镜生成系统提示词：输出 shots 数组的结构化 JSON（mock 测试按 "shots" 契约标记识别） */
const STORYBOARD_SYSTEM_PROMPT = `你是资深影视分镜师。把用户的创意拆解为节奏完整、镜头间可无缝衔接的分镜脚本。
只输出一个 JSON 对象（不要 markdown 代码块、不要注释），结构如下：
{
  "shots": [
    {
      "seq": 1,
      "title": "镜头标题，8 字内，格式如「开场·麦田全景」「转折·回眸特写」",
      "video_prompt": "该镜头的视频生成提示词，150~200 字，六段式按序书写：①景别与运镜（如：大全景，镜头缓慢推进）②主体与动作（角色在做什么，动作设计需能自然衔接下一镜）③环境与细节（具体可拍的地物、道具）④光线与色调（时段、光源方向、色温）⑤视觉风格（全片统一的关键词）⑥声音与节奏。有角色出镜的镜头必须以「以 <Picture 1> 中的角色为参考，保持其外观一致」开头；纯环境/空镜/无角色镜头直接从景别写起，不要提及 <Picture 1>",
      "narration": "该镜头的旁白文案，15~40 字，讲述式语气，与画面互补而非复述画面内容：推进叙事、交代背景或点染情绪；全片旁白连起来应是一篇完整的短文",
      "seconds": "5"
    }
  ]
}
分镜节奏要求：第一镜负责建立时空（交代环境与主角出场），中间镜头递进冲突或细节，最后一镜收束情绪；相邻镜头的动作与视线方向连贯（遵守 180° 轴线，不越轴）；全片视觉风格关键词完全一致；seconds 只能是 "4"~"12" 的字符串；动作量与该镜时长匹配（5 秒最多 2~3 个动作）；镜头数量遵循用户指定数量（未指定则按叙事需要 3~8 个）。`;

/** 下载远程产物到本地 artifacts 做永久备份（失败不阻塞）—— 实现在 artifacts.js，供 server/poller 共用 */

/** 校验图片请求并构建 payload（文生图 / 图生图 / 多图合成） */
function buildImagePayload(b) {
  const prompt = String(b.prompt || '').trim();
  if (!prompt) throw new ApiError(400, '图片描述 prompt 不能为空');
  if (prompt.length > MAX_TEXT_LEN) throw new ApiError(400, `prompt 长度需 ≤ ${MAX_TEXT_LEN}`);
  const size = String(b.size || '1K');
  if (!IMAGE_SIZES.includes(size)) {
    // 自定义尺寸：限制每边最大 4096，防止无界数值透传上游
    const m = /^\d{2,4}x\d{2,4}$/.exec(size);
    const [w, h] = m ? size.split('x').map(Number) : [0, 0];
    if (!m || w > 4096 || h > 4096) {
      throw new ApiError(400, `size 仅支持 ${IMAGE_SIZES.join('/')} 或 ≤4096 的精确尺寸（如 1024x768），收到：${size}`);
    }
  }
  const ratio = String(b.ratio || '1:1');
  if (b.ratio !== undefined && !IMAGE_RATIOS.includes(ratio)) {
    throw new ApiError(400, `ratio 仅支持 ${IMAGE_RATIOS.join('/')}，收到：${ratio}`);
  }
  // 输入图：允许 http(s) URL 或 data:image base64（图生图 / 多图合成），数量受限
  const inputImages = [];
  if (b.image !== undefined && b.image !== null && b.image !== '') {
    if (!Array.isArray(b.image)) throw new ApiError(400, 'image 必须是数组（URL 或 data:image）');
    for (const u of b.image) {
      const s = typeof u === 'string' ? u.trim() : '';
      if (!s) continue;
      if (!(isHttpUrl(s) || /^data:image\//.test(s))) {
        throw new ApiError(400, `image 必须是可公开访问的 http(s) URL 或 data:image 前缀，收到：${s.slice(0, 50)}`);
      }
      inputImages.push(s);
    }
    if (inputImages.length > MAX_INPUT_IMAGES) {
      throw new ApiError(400, `image 最多 ${MAX_INPUT_IMAGES} 张`);
    }
  }
  const payload = {
    model: IMAGE_MODEL,
    prompt,
    size,
    extra_body: { response_format: 'url' },
  };
  if (b.ratio !== undefined) payload.ratio = ratio;
  if (inputImages.length) payload.extra_body.image = inputImages;
  return { payload, prompt, size, ratio: b.ratio !== undefined ? ratio : null, inputImages };
}

/** 规范化分镜数组（LLM 输出 / 历史 storyboard 版本通用）：重编 seq、裁剪长度、seconds 白名单兜底 */
function normalizeStoryboardShots(rawShots, fallbackSeconds = '5') {
  const fb = SECONDS_OK.includes(String(fallbackSeconds)) ? String(fallbackSeconds) : '5';
  const out = [];
  for (const s of (rawShots || []).slice(0, MAX_SHOTS)) {
    const vp = String(s?.video_prompt || '').trim();
    if (!vp) continue; // 空提示词镜头直接丢弃
    out.push({
      seq: out.length + 1,
      title: String(s?.title || '').trim().slice(0, 100) || null,
      video_prompt: vp.slice(0, MAX_TEXT_LEN),
      narration: String(s?.narration || '').trim().slice(0, 200) || null, // v1.3 镜头旁白
      seconds: SECONDS_OK.includes(String(s?.seconds)) ? String(s.seconds) : fb,
      mode: 'reference',
    });
  }
  return out;
}

/* ---------- 文本 / LLM ---------- */

// 通用文本生成（OpenAI 兼容）
app.post('/api/llm/chat', ah(async (req, res) => {
  const b = req.body || {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  if (!messages.length) throw new ApiError(400, 'messages 至少需要一条消息');
  if (messages.length > MAX_MESSAGES) throw new ApiError(400, `messages 最多 ${MAX_MESSAGES} 条`);
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new ApiError(400, 'messages 每项需为 {role, content} 对象');
    }
    if (!['system', 'user', 'assistant'].includes(m.role)) {
      throw new ApiError(400, `messages role 仅支持 system/user/assistant，收到：${m.role}`);
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      throw new ApiError(400, 'messages 每项 content 必须是非空字符串');
    }
    if (m.content.length > MAX_TEXT_LEN) {
      throw new ApiError(400, `messages 单条 content 长度需 ≤ ${MAX_TEXT_LEN}`);
    }
  }
  if (b.system !== undefined && (typeof b.system !== 'string' || b.system.length > MAX_TEXT_LEN)) {
    throw new ApiError(400, `system 必须是长度 ≤ ${MAX_TEXT_LEN} 的字符串`);
  }
  const temperature = b.temperature !== undefined ? Number(b.temperature) : undefined;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new ApiError(400, 'temperature 需在 0–2 之间');
  }
  const maxTokens = b.max_tokens !== undefined ? Number(b.max_tokens) : undefined;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192)) {
    throw new ApiError(400, 'max_tokens 需为 1–8192 的整数');
  }
  if (b.model !== undefined && b.model !== LLM_MODEL) {
    throw new ApiError(400, `暂只支持文本模型 ${LLM_MODEL}，收到：${b.model}`);
  }
  if (b.system) messages.unshift({ role: 'system', content: b.system });
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
  let r;
  try {
    r = await agnes.chatComplete({
      apiKey,
      baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
      model: LLM_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
  } catch (e) {
    throw new ApiError(502, `文本生成网络异常：${e.message}`);
  }
  if (!r.ok) {
    const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
    throw new ApiError(r.status >= 400 && r.status < 500 ? 400 : 502, `文本生成失败（${r.status}）：${String(detail).slice(0, 400)}`);
  }
  const content = r.data?.choices?.[0]?.message?.content || '';
  if (!content) throw new ApiError(502, '文本模型未返回内容');
  res.json({ content, model: r.data?.model || LLM_MODEL });
}));

// 创意 → 结构化文案（流水线第 2 步）
app.post('/api/llm/script', ah(async (req, res) => {
  const b = req.body || {};
  const idea = String(b.idea || '').trim();
  if (!idea) throw new ApiError(400, '请先输入创意想法 idea');
  if (idea.length > MAX_TEXT_LEN) throw new ApiError(400, `idea 长度需 ≤ ${MAX_TEXT_LEN}`);
  const style = b.style ? String(b.style).trim().slice(0, 200) : '';
  if (b.aspect_ratio !== undefined && !ASPECT_RATIOS.includes(b.aspect_ratio)) {
    throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
  }
  if (b.seconds !== undefined && !SECONDS_OK.includes(String(b.seconds))) {
    throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
  }
  if (b.project_id !== undefined && !projects.get(b.project_id)) throw new ApiError(404, '项目不存在');
  const userMessage = `一句话创意：${idea}\n风格偏好：${style || '不限制'}\n画幅：${b.aspect_ratio || '16:9'}\n目标时长：${b.seconds || '5'} 秒`;
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
  let r;
  try {
    r = await agnes.chatComplete({
      apiKey,
      baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
      model: LLM_MODEL,
      messages: [{ role: 'system', content: SCRIPT_SYSTEM_PROMPT }, { role: 'user', content: userMessage }],
      temperature: 0.8,
      max_tokens: 2000,
    });
  } catch (e) {
    throw new ApiError(502, `文案生成网络异常：${e.message}`);
  }
  if (!r.ok) {
    const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
    throw new ApiError(r.status >= 400 && r.status < 500 ? 400 : 502, `文案生成失败（${r.status}）：${String(detail).slice(0, 400)}`);
  }
  const raw = r.data?.choices?.[0]?.message?.content || '';
  const parsed = parseLLMJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    // 降级：模型没按 JSON 输出，返回原文由前端展示
    return res.json({ parsed: false, content: raw, result: null });
  }
  const result = {
    script: String(parsed.script || '').trim(),
    video_prompt: String(parsed.video_prompt || '').trim(),
    character_desc: String(parsed.character_desc || '').trim(),
    scene_desc: String(parsed.scene_desc || '').trim(),
  };
  // 落库到项目（若指定）。auto_select=false 时新版只落库不选中：
  // 前端弹「新旧对比」窗，由用户决定采用（再调 select-text）还是保留当前版本
  const autoSelect = b.auto_select === undefined ? true : Boolean(b.auto_select);
  let texts = null;
  let newTextIds = null;
  let previous = null;
  if (b.project_id) {
    if (!autoSelect) {
      previous = {};
      newTextIds = {};
      for (const kind of SCRIPT_KINDS) {
        const cur = projects.selectedText(b.project_id, kind)
          || projects.texts(b.project_id).find((t) => t.kind === kind)
          || null;
        if (cur) previous[kind] = { id: cur.id, content: cur.content };
      }
    }
    for (const kind of SCRIPT_KINDS) {
      if (!result[kind]) continue;
      const tid = projects.addText({ project_id: b.project_id, kind, content: result[kind], model: LLM_MODEL });
      if (autoSelect) projects.selectText(tid, kind, b.project_id);
      else newTextIds[kind] = tid;
    }
    if (autoSelect) projects.update(b.project_id, { status: 'copy_done' });
    texts = projects.texts(b.project_id);
    log('info', `项目 #${b.project_id} 文案生成完成${autoSelect ? '' : '（待用户确认采用）'}`);
  }
  res.json({ parsed: true, result, texts, new_text_ids: newTextIds, previous, model: r.data?.model || LLM_MODEL });
}));

// 创意 → 分镜脚本（M2：多镜头 storyboard；整体版本落 project_texts.kind=storyboard，工作副本落 shots）
app.post('/api/llm/storyboard', ah(async (req, res) => {
  const b = req.body || {};
  const idea = String(b.idea || '').trim();
  if (!idea) throw new ApiError(400, '请先输入创意想法 idea');
  if (idea.length > MAX_TEXT_LEN) throw new ApiError(400, `idea 长度需 ≤ ${MAX_TEXT_LEN}`);
  const style = b.style ? String(b.style).trim().slice(0, 200) : '';
  const shotCount = SHOT_COUNTS.includes(String(b.shot_count)) ? String(b.shot_count) : 'auto';
  if (b.aspect_ratio !== undefined && !ASPECT_RATIOS.includes(b.aspect_ratio)) {
    throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
  }
  if (b.seconds !== undefined && !SECONDS_OK.includes(String(b.seconds))) {
    throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
  }
  if (b.project_id !== undefined && b.project_id !== null && !projects.get(b.project_id)) {
    throw new ApiError(404, '项目不存在');
  }
  const countText = shotCount === 'auto' ? '未指定（按叙事需要 3~8 个）' : `恰好 ${shotCount} 个`;
  const userMessage = `一句话创意：${idea}\n风格偏好：${style || '不限制'}\n画幅：${b.aspect_ratio || '16:9'}\n单镜头目标时长：${b.seconds || '5'} 秒\n镜头数量：${countText}`;
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
  let r;
  try {
    r = await agnes.chatComplete({
      apiKey,
      baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
      model: LLM_MODEL,
      messages: [{ role: 'system', content: STORYBOARD_SYSTEM_PROMPT }, { role: 'user', content: userMessage }],
      temperature: 0.8,
      max_tokens: 4000,
    });
  } catch (e) {
    throw new ApiError(502, `分镜生成网络异常：${e.message}`);
  }
  if (!r.ok) {
    const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
    throw new ApiError(r.status >= 400 && r.status < 500 ? 400 : 502, `分镜生成失败（${r.status}）：${String(detail).slice(0, 400)}`);
  }
  const raw = r.data?.choices?.[0]?.message?.content || '';
  const parsed = parseLLMJson(raw);
  const rawShots = parsed && typeof parsed === 'object' && Array.isArray(parsed.shots) ? parsed.shots : null;
  if (!rawShots) {
    // 降级：模型没按 JSON 输出，返回原文由前端展示
    return res.json({ parsed: false, content: raw, shots: null, texts: null });
  }
  // 规范化镜头：重编 seq、裁剪长度、seconds 白名单兜底（与历史版本选用共用同一规范化）
  const normalized = normalizeStoryboardShots(rawShots, SECONDS_OK.includes(String(b.seconds)) ? String(b.seconds) : '5');
  if (!normalized.length) {
    return res.json({ parsed: false, content: raw, shots: null, texts: null });
  }
  let shotsOut = null;
  let texts = null;
  // auto_select=false：仅落 storyboard 版本，不选中、不重建 shots —— 前端弹对比窗，
  // 用户「采用新版」时调 /storyboard/apply（选中 + 重建），「保留当前」则无副作用
  const autoSelect = b.auto_select === undefined ? true : Boolean(b.auto_select);
  if (b.project_id) {
    const content = JSON.stringify({ shots: normalized });
    const tid = projects.addText({ project_id: b.project_id, kind: 'storyboard', content, model: LLM_MODEL });
    if (autoSelect) {
      projects.selectText(tid, 'storyboard', b.project_id);
      projects.replaceShots(b.project_id, normalized);
      shotsOut = projects.shots(b.project_id);
      texts = projects.texts(b.project_id);
      log('info', `项目 #${b.project_id} 分镜生成完成（${normalized.length} 个镜头）`);
    } else {
      shotsOut = normalized;
      texts = projects.texts(b.project_id);
      log('info', `项目 #${b.project_id} 分镜生成待确认（新版本 #${tid}，${normalized.length} 个镜头）`);
      return res.json({ parsed: true, shots: shotsOut, current_shots: projects.shots(b.project_id), text_id: tid, auto_selected: false, texts, model: r.data?.model || LLM_MODEL });
    }
  } else {
    shotsOut = normalized;
  }
  res.json({ parsed: true, shots: shotsOut, auto_selected: true, texts, model: r.data?.model || LLM_MODEL });
}));

/* ---------- 图片 ---------- */

// 图片生成（文生图 / 图生图，同步；count 支持 1/2/4 张并行，供挑选种子图）
app.post('/api/images/generate', ah(async (req, res) => {
  const { payload, prompt, size, ratio } = buildImagePayload(req.body);
  const b = req.body || {};
  const kind = ['character', 'scene'].includes(b.kind) ? b.kind : 'character';
  const count = [1, 2, 3, 4].includes(Number(b.count)) ? Number(b.count) : 1;
  if (b.project_id !== undefined && !projects.get(b.project_id)) throw new ApiError(404, '项目不存在');
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
  // 并行生成 count 张；多张时部分失败不阻塞成功者
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => agnes.generateImage({
      apiKey,
      baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
      payload,
    }))
  );
  const remoteUrls = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value.ok) continue;
    const u = safeUrl(s.value.data?.data?.[0]?.url);
    if (u) remoteUrls.push(u);
  }
  if (!remoteUrls.length) {
    const detail = settled.find((s) => s.status === 'rejected')?.reason?.message
      || (settled[0].status === 'fulfilled'
        ? (settled[0].value.data?.error?.message || settled[0].value.raw || `HTTP ${settled[0].value.status}`)
        : '未知错误');
    throw new ApiError(502, `图片生成失败：${String(detail).slice(0, 300)}`);
  }
  // 逐张落库（含本地备份下载），第一张成功图自动定稿
  const results = [];
  let first = null;
  for (let i = 0; i < remoteUrls.length; i++) {
    const remoteUrl = remoteUrls[i];
    const backup = await downloadArtifact(remoteUrl);
    let image = null;
    if (b.project_id) {
      const imgId = projects.addImage({
        project_id: b.project_id, kind, prompt, remote_url: remoteUrl,
        local_path: backup?.local_path || null, size, ratio, model: IMAGE_MODEL,
      });
      if (i === 0) {
        projects.selectImage(imgId, kind, b.project_id);
        if (kind === 'character') projects.update(b.project_id, { status: 'character_done' });
      }
      image = projects.images(b.project_id).find((x) => x.id === imgId) || null;
    }
    const item = { remote_url: remoteUrl, local_url: backup?.local_url || null, size, ratio, image };
    results.push(item);
    if (i === 0) first = item;
  }
  const failed = count - remoteUrls.length;
  log('info', `图片生成：成功 ${remoteUrls.length}/${count} 张${b.project_id ? `（项目 #${b.project_id} ${kind === 'character' ? '角色图' : '场景图'}）` : ''}${failed ? `，失败 ${failed} 张` : ''}`);
  res.json({
    remote_url: first.remote_url,
    local_url: first.local_url,
    size, ratio,
    image: first.image,
    results,
    failed,
  });
}));

// 删除项目图片记录
app.delete('/api/images/:id', (req, res) => {
  if (!projects.removeImage(req.params.id)) throw new ApiError(404, '图片记录不存在');
  res.json({ ok: true });
});

/* ---------- TTS 配音（Fish Audio） ---------- */

// 常用音色快捷清单（缺省 default = 平台默认音色；其余为 Fish 音色库公开模型 id，供前端下拉）
const TTS_VOICES = [
  { id: 'default', title: '平台默认音色', desc: '不指定音色，用 Fish 平台默认声线（免费档推荐）' },
  { id: '6fc59d2b56cf402eb572934114c8d8aa', title: '仿真人·故事男声', desc: '成熟男声、情绪平稳，适合故事旁白（小满同款）' },
  { id: '59cb5986671546eaa6ca8ae6f29f6d22', title: '央视配音·男声', desc: '专业中年男声、权威清晰，适合纪录片式旁白' },
  { id: '918a8277663d476b95e2c4867da0f6a6', title: '沉稳男声·广播', desc: '有分量感的中低音，适合人生感悟类口播' },
  { id: 'bc9e47fd83a04010ad6617ed54b92ee3', title: '活力男声·解说', desc: '快节奏、有说服力，适合干货口播' },
];
const TTS_MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'];
const TTS_MAX_TEXT = 8000;

// 音色清单
app.get('/api/tts/voices', (req, res) => {
  res.json({ voices: TTS_VOICES, models: TTS_MODELS });
});

// 音频时长探测（ffprobe 不存在时返回 null 不阻塞）
function probeDuration(filePath) {
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0 && r.stdout) {
      const d = Number(r.stdout.trim());
      return Number.isFinite(d) ? Math.round(d * 100) / 100 : null;
    }
    return null;
  } catch { return null; }
}

// TTS 合成：{text, kind?, project_id?, voice?, speed?, model?} → mp3 落库
app.post('/api/tts/generate', ah(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim();
  if (!text) throw new ApiError(400, '请先输入配音文本 text');
  if (text.length > TTS_MAX_TEXT) throw new ApiError(400, `text 长度需 ≤ ${TTS_MAX_TEXT}`);
  const apiKey = settings.get('fish_api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 Fish Audio API Key，请先在「设置」中填写（TTS 配音）');
  const kind = ['narration', 'shot'].includes(b.kind) ? b.kind : 'narration';
  const projectId = b.project_id === undefined || b.project_id === null ? null : Number(b.project_id);
  if (projectId !== null && !projects.get(projectId)) throw new ApiError(404, '项目不存在');
  // v1.3：旁白可绑定到具体镜头（渲染成片时按镜头对齐时间轴）
  const shotId = b.shot_id === undefined || b.shot_id === null ? null : Number(b.shot_id);
  if (shotId !== null) {
    if (projectId === null) throw new ApiError(400, 'shot_id 需与 project_id 同时提供');
    if (!projects.shots(projectId).some((s) => s.id === shotId)) throw new ApiError(404, '镜头不存在（或不属于该项目）');
  }
  const effKind = b.kind === undefined && shotId !== null ? 'shot' : kind;
  const voice = TTS_VOICES.some((v) => v.id === String(b.voice || ''))
    ? String(b.voice) : settings.get('fish_voice', 'default');
  const speed = b.speed !== undefined ? Number(b.speed) : Number(settings.get('fish_speed', '1'));
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new ApiError(400, 'speed 需在 0.5–2.0 之间');
  const model = TTS_MODELS.includes(String(b.model)) ? String(b.model) : 's2.1-pro-free';
  const referenceId = voice === 'default' ? null : voice;
  const voiceTitle = TTS_VOICES.find((v) => v.id === voice)?.title || (referenceId ? voice : '平台默认音色');

  const r = await fishTts.synthesize({ apiKey, text, referenceId, model, speed, format: 'mp3' });
  if (!r.ok) {
    const detail = r.raw || `HTTP ${r.status}`;
    if (projectId !== null) {
      projects.addTts({ project_id: projectId, kind: effKind, shot_id: shotId, text, model, reference_id: referenceId, voice_title: voiceTitle, error_message: String(detail).slice(0, 300) });
    }
    throw new ApiError(r.status >= 400 && r.status < 500 ? 400 : 502, `配音生成失败（${r.status}）：${String(detail).slice(0, 300)}`);
  }
  // 保存本地 artifacts
  let localPath = null;
  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const name = `tts${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`;
    localPath = path.join(ARTIFACTS_DIR, name);
    fs.writeFileSync(localPath, r.buf);
  } catch {
    localPath = null;
  }
  const duration = localPath ? probeDuration(localPath) : null;
  let ttsRow = null;
  if (projectId !== null) {
    const tid = projects.addTts({
      project_id: projectId, kind: effKind, shot_id: shotId, text, model, reference_id: referenceId,
      voice_title: voiceTitle, format: 'mp3', local_path: localPath,
      duration, size: r.buf ? r.buf.length : null,
    });
    // 第一次生成成功自动选用（与角色图首张自动定稿一致）
    projects.selectTts(tid, projectId);
    ttsRow = projects.getTts(tid);
  }
  log('info', `TTS 配音生成成功 ${projectId ? `（项目 #${projectId} ${effKind}${shotId ? ` #镜头${shotId}` : ''}）` : ''} 音色=${voiceTitle} 时长=${duration || '?'}s${localPath ? ' 已存本地' : ''}`);
  res.json({
    ok: true,
    text, voice: referenceId, voice_title: voiceTitle, model,
    duration, size: r.buf ? r.buf.length : null,
    local_url: localPath ? '/artifacts/' + path.basename(localPath) : null,
    tts: ttsRow,
  });
}));

// 选用配音记录（同项目内 selected 互斥）
app.post('/api/tts/:id/select', (req, res) => {
  const t = projects.getTts(req.params.id);
  if (!t) throw new ApiError(404, '配音记录不存在');
  const projectId = Number(req.body?.project_id ?? t.project_id);
  if (!projects.get(projectId)) throw new ApiError(404, '项目不存在');
  projects.selectTts(t.id, projectId);
  res.json({ ok: true, tts: projects.getTts(t.id) });
});

// v1.5 旁白绑定镜头：{shot_id} 把已有配音记录绑到指定镜头（kind 自动转 shot），成片渲染时按镜头对齐；
// shot_id 传 null 解绑（kind 回 narration）。同一镜头绑新记录时会自动解绑旧记录。
app.post('/api/tts/:id/bind', (req, res) => {
  const t = projects.getTts(req.params.id);
  if (!t) throw new ApiError(404, '配音记录不存在');
  if (!t.local_path || t.error_message) throw new ApiError(400, '该配音记录无有效本地音频，无法绑定');
  const projectId = Number(req.body?.project_id ?? t.project_id);
  if (!projects.get(projectId)) throw new ApiError(404, '项目不存在');
  const raw = req.body?.shot_id;
  const shotId = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  if (shotId !== null) {
    if (!projects.shots(projectId).some((s) => s.id === shotId)) throw new ApiError(404, '镜头不存在（或不属于该项目）');
    // 同镜头互斥：旧绑定自动解绑为 narration
    for (const other of projects.tts(projectId)) {
      if (other.id !== t.id && other.kind === 'shot' && other.shot_id === shotId) {
        projects.bindTts(other.id, null, null);
      }
    }
  }
  projects.bindTts(t.id, shotId === null ? 'narration' : 'shot', shotId);
  log('info', `配音 #${t.id} ${shotId === null ? '解绑' : `绑定镜头 #${shotId}`}(项目 #${projectId})`);
  res.json({ ok: true, tts: projects.getTts(t.id) });
});

// 删除配音记录
app.delete('/api/tts/:id', (req, res) => {
  if (!projects.removeTts(req.params.id)) throw new ApiError(404, '配音记录不存在');
  res.json({ ok: true });
});

/* ---------- BGM 音乐（v1.4：搜索 / 试听代理 / 项目选歌） ---------- */

const MUSIC_LEVELS = netmusic.LEVELS;

// 搜索歌曲（代理音乐接口，规范化字段）
app.get('/api/music/search', ah(async (req, res) => {
  const keyword = String(req.query.keyword || '').trim().slice(0, 100);
  if (!keyword) throw new ApiError(400, '请输入搜索关键词 keyword');
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 50);
  const items = await netmusic.search(keyword, limit);
  res.json({ items, keyword, limit });
}));

// 试听流代理：现取播放地址并把音频流转发给浏览器（播放地址有时效性，不能落库直链）
app.get('/api/music/stream', ah(async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^\d+$/.test(id)) throw new ApiError(400, 'id 需为纯数字歌曲 ID');
  const level = MUSIC_LEVELS.includes(String(req.query.level)) ? String(req.query.level) : undefined;
  const { url } = await netmusic.playUrl(id, level);
  const upstream = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!upstream.ok || !upstream.body) throw new ApiError(502, `试听流获取失败（HTTP ${upstream.status}）`);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  Readable.fromWeb(upstream.body).pipe(res);
}));

// 项目选用 BGM：{song_id, name, artist?, album?, level?} → 立即下载缓存本地并落库
app.post('/api/projects/:id/bgm', ah(async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const b = req.body || {};
  const songId = String(b.song_id || '').trim();
  if (!/^\d+$/.test(songId)) throw new ApiError(400, 'song_id 需为纯数字歌曲 ID');
  const level = MUSIC_LEVELS.includes(String(b.level)) ? String(b.level)
    : settings.get('music_level', DEFAULT_SETTINGS.music_level);
  const dl = await netmusic.downloadBGM(songId, level);
  const bgm = {
    song_id: songId,
    name: String(b.name || '').trim().slice(0, 200) || `歌曲 ${songId}`,
    artist: String(b.artist || '').trim().slice(0, 100) || '',
    album: String(b.album || '').trim().slice(0, 100) || '',
    level,
    local_path: dl.local_path,
    local_url: dl.local_url,
    cached: dl.cached,
    selected_at: Date.now(),
  };
  projects.setBgm(p.id, bgm);
  log('info', `项目 #${p.id} 选用 BGM：《${bgm.name}》- ${bgm.artist}（${level}${dl.cached ? '，缓存命中' : '，已下载'}）`);
  res.json({ ok: true, bgm });
}));

// 清除项目 BGM 选择（本地缓存文件保留，便于再次选用）
app.delete('/api/projects/:id/bgm', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  projects.setBgm(p.id, null);
  log('info', `项目 #${p.id} 清除 BGM 选择`);
  res.json({ ok: true });
});

/* ---------- 项目（Projects） ---------- */

app.post('/api/projects', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw new ApiError(400, '项目名称不能为空');
  if (b.aspect_ratio && !ASPECT_RATIOS.includes(b.aspect_ratio)) throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
  if (b.seconds && !SECONDS_OK.includes(String(b.seconds))) throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
  const id = projects.insert({
    name, idea: b.idea, style: b.style, aspect_ratio: b.aspect_ratio, seconds: b.seconds,
  });
  res.status(201).json(projects.get(id));
});

app.get('/api/projects', (req, res) => res.json({ items: projects.list() }));

app.get('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  res.json({
    project: p,
    texts: projects.texts(p.id),
    images: projects.images(p.id),
    shots: projects.shots(p.id),
    tasks: projects.tasks(p.id),
    tts: projects.tts(p.id),   // TTS 配音记录
  });
});

app.patch('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const b = req.body || {};
  if (b.name !== undefined) {
    const n = String(b.name).trim();
    if (!n) throw new ApiError(400, '项目名称不能为空');
    b.name = n;
  }
  if (b.status !== undefined && !PROJECT_STATUSES.includes(b.status)) {
    throw new ApiError(400, `status 仅支持 ${PROJECT_STATUSES.join('/')}`);
  }
  if (b.aspect_ratio !== undefined && b.aspect_ratio !== null && !ASPECT_RATIOS.includes(b.aspect_ratio)) throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
  if (b.seconds !== undefined && b.seconds !== null && !SECONDS_OK.includes(String(b.seconds))) throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
  if (b.idea !== undefined && b.idea !== null && String(b.idea).length > MAX_TEXT_LEN) throw new ApiError(400, `idea 长度需 ≤ ${MAX_TEXT_LEN}`);
  if (b.style !== undefined && b.style !== null) b.style = String(b.style).trim().slice(0, 200) || null;
  projects.update(p.id, {
    name: b.name, idea: b.idea, style: b.style, aspect_ratio: b.aspect_ratio, seconds: b.seconds, status: b.status,
  });
  res.json(projects.get(p.id));
});

app.delete('/api/projects/:id', (req, res) => {
  if (!projects.remove(req.params.id)) throw new ApiError(404, '项目不存在');
  res.json({ ok: true });
});

// 选定文案版本（同一 kind 只有一条 selected）
app.post('/api/projects/:id/select-text', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const textId = Number(req.body?.text_id);
  const target = projects.texts(p.id).find((t) => t.id === textId);
  if (!target) throw new ApiError(404, '文案记录不存在');
  projects.selectText(textId, target.kind, p.id);
  res.json({ ok: true });
});

// 编辑文案版本内容（手动微调；校验文案归属当前项目，防跨项目越权编辑）
app.patch('/api/projects/:id/texts/:textId', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const content = String(req.body?.content ?? '').trim();
  if (!content) throw new ApiError(400, '内容不能为空');
  if (content.length > MAX_TEXT_LEN) throw new ApiError(400, `内容长度需 ≤ ${MAX_TEXT_LEN}`);
  const target = projects.texts(p.id).find((t) => t.id === Number(req.params.textId));
  if (!target) throw new ApiError(404, '文案记录不存在');
  if (!projects.updateText(target.id, content)) throw new ApiError(404, '文案记录不存在');
  res.json({ ok: true });
});

// 选定图片定稿（同一 kind 只有一张 selected）
app.post('/api/projects/:id/select-image', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const imgId = Number(req.body?.image_id);
  const target = projects.images(p.id).find((x) => x.id === imgId);
  if (!target) throw new ApiError(404, '图片记录不存在');
  projects.selectImage(imgId, target.kind, p.id);
  res.json({ ok: true });
});

/* ---------- 镜头（M2 分镜工作副本） ---------- */

// 选用历史 storyboard 版本 → 重建镜头工作副本（选中该版本 + 整体替换 shots）
app.post('/api/projects/:id/storyboard/apply', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const textId = Number(req.body?.text_id);
  const target = projects.texts(p.id).find((t) => t.id === textId && t.kind === 'storyboard');
  if (!target) throw new ApiError(404, 'storyboard 版本不存在');
  let parsedContent;
  try {
    parsedContent = JSON.parse(target.content || '{}');
  } catch {
    throw new ApiError(400, '该 storyboard 版本内容不是合法 JSON');
  }
  const shots = normalizeStoryboardShots(parsedContent.shots, p.seconds || '5');
  if (!shots.length) throw new ApiError(400, '该 storyboard 版本没有有效镜头');
  projects.selectText(target.id, 'storyboard', p.id);
  projects.replaceShots(p.id, shots);
  log('info', `项目 #${p.id} 选用 storyboard 版本 #${target.id}（${shots.length} 个镜头）`);
  res.json({ ok: true, shots: projects.shots(p.id) });
});

// 手动添加镜头（追加到末尾）
app.post('/api/projects/:id/shots', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const existing = projects.shots(p.id);
  if (existing.length >= MAX_SHOTS) throw new ApiError(400, `每个项目最多 ${MAX_SHOTS} 个镜头`);
  const b = req.body || {};
  const vp = String(b.video_prompt || '').trim();
  if (!vp) throw new ApiError(400, 'video_prompt 不能为空');
  if (vp.length > MAX_TEXT_LEN) throw new ApiError(400, `video_prompt 长度需 ≤ ${MAX_TEXT_LEN}`);
  if (b.seconds !== undefined && b.seconds !== null && !SECONDS_OK.includes(String(b.seconds))) {
    throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
  }
  const mode = SHOT_MODES.includes(b.mode) ? b.mode : 'reference';
  const maxSeq = existing.reduce((m, s) => Math.max(m, s.seq), 0);
  const id = projects.addShot({
    project_id: p.id, seq: maxSeq + 1,
    title: String(b.title || '').trim().slice(0, 100) || null,
    video_prompt: vp, seconds: b.seconds || null, mode,
    narration: b.narration !== undefined && b.narration !== null ? String(b.narration) : undefined,
    use_character_ref: b.use_character_ref,
  });
  res.status(201).json(projects.shots(p.id).find((s) => s.id === id));
});

// 编辑镜头（标题/提示词/时长/旁白/引用开关；归属校验防跨项目越权）
app.patch('/api/projects/:id/shots/:shotId', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
  if (!shot) throw new ApiError(404, '镜头不存在');
  const b = req.body || {};
  const patch = {};
  if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 100) || null;
  if (b.video_prompt !== undefined) {
    const vp = String(b.video_prompt).trim();
    if (!vp) throw new ApiError(400, 'video_prompt 不能为空');
    if (vp.length > MAX_TEXT_LEN) throw new ApiError(400, `video_prompt 长度需 ≤ ${MAX_TEXT_LEN}`);
    patch.video_prompt = vp;
  }
  if (b.seconds !== undefined) {
    if (b.seconds !== null && !SECONDS_OK.includes(String(b.seconds))) throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
    patch.seconds = b.seconds;
  }
  // v1.3：旁白文案与角色引用开关
  if (b.narration !== undefined) {
    patch.narration = b.narration === null ? null : String(b.narration).trim().slice(0, 200) || null;
  }
  if (b.use_character_ref !== undefined) {
    patch.use_character_ref = b.use_character_ref ? 1 : 0;
  }
  projects.updateShot(shot.id, patch);
  res.json(projects.shots(p.id).find((s) => s.id === shot.id));
});

// 删除镜头（关联视频任务保留，shot_id 成为历史引用）
app.delete('/api/projects/:id/shots/:shotId', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
  if (!shot) throw new ApiError(404, '镜头不存在');
  projects.removeShot(shot.id);
  res.json({ ok: true });
});

// 镜头排序：ids 按新顺序给出，必须与现有镜头一一对应（不重不漏）
app.post('/api/projects/:id/shots/reorder', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) throw new ApiError(400, 'ids 必须是非空数组');
  const current = projects.shots(p.id);
  const idSet = new Set(current.map((s) => s.id));
  const reqIds = ids.map(Number);
  if (reqIds.length !== current.length || reqIds.some((id) => !idSet.has(id)) || new Set(reqIds).size !== reqIds.length) {
    throw new ApiError(400, 'ids 必须与项目现有镜头一一对应（不重不漏）');
  }
  projects.reorderShots(p.id, reqIds);
  res.json({ ok: true, shots: projects.shots(p.id) });
});

// 单镜头提交视频任务（M2 主入口；复用 pipeline 服务层组装与溯源）
app.post('/api/projects/:id/shots/:shotId/videos', ah(async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
  if (!shot) throw new ApiError(404, '镜头不存在');
  const b = req.body || {};
  const task = await pipeline.submitVideoTask({
    projectId: p.id,
    shot, // v1.3：传入镜头行，pipeline 据此尊重 use_character_ref / mode
    prompt: shot.video_prompt,
    seconds: b.seconds || shot.seconds,
    aspectRatio: b.aspect_ratio,
    shotId: shot.id,
  });
  res.status(201).json(task);
}));

// v1.7 镜头重拍：一次提交 N 条候选任务（提交队列自动按分钟节流；完成后在下方选定 take）
app.post('/api/projects/:id/shots/:shotId/retakes', ah(async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
  if (!shot) throw new ApiError(404, '镜头不存在');
  const b = req.body || {};
  const count = Math.min(Math.max(Math.round(Number(b.count) || 1), 1), 3);
  const created = [];
  for (let i = 0; i < count; i++) {
    const task = await pipeline.submitVideoTask({
      projectId: p.id,
      shot,
      prompt: shot.video_prompt,
      seconds: b.seconds || shot.seconds,
      aspectRatio: b.aspect_ratio,
      shotId: shot.id,
    });
    created.push({ id: task.id, status: task.status });
  }
  log('info', `项目 #${p.id} 镜头 #${shot.id}（seq ${shot.seq}）重拍 ${created.length} 条候选`);
  res.status(201).json({ ok: true, retakes: created });
}));

// v1.7 镜头选定定稿 take：{task_id}（须为该镜头已完成且有产物的任务）；task_id=null 恢复自动模式
app.post('/api/projects/:id/shots/:shotId/select-take', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
  if (!shot) throw new ApiError(404, '镜头不存在');
  const raw = req.body?.task_id;
  if (raw === null || raw === undefined || raw === '') {
    projects.setShotTake(shot.id, null);
    log('info', `镜头 #${shot.id} 恢复自动模式（渲染用最新完成条）`);
    return res.json({ ok: true, shot: projects.shots(p.id).find((s) => s.id === shot.id) });
  }
  const taskId = Number(raw);
  const task = projects.tasks(p.id).find((t) => t.id === taskId && t.shot_id === shot.id);
  if (!task) throw new ApiError(404, '任务不存在（或不属于该镜头）');
  if (task.status !== 'completed' || (!task.video_local_path && !task.metadata_url)) {
    throw new ApiError(400, '只有已完成且有产物的任务才能定为定稿 take');
  }
  projects.setShotTake(shot.id, taskId);
  log('info', `镜头 #${shot.id}（seq ${shot.seq}）选定定稿 take：任务 #${taskId}`);
  res.json({ ok: true, shot: projects.shots(p.id).find((s) => s.id === shot.id) });
});

// 从项目发起视频任务（旧入口，保留原语义）：角色定稿图 + 选定分镜提示词 → 2.5-flash reference 模式。
// 组装与溯源逻辑在 pipeline.js 服务层；M2 起新流程走 /api/projects/:id/shots/:shotId/videos
app.post('/api/projects/:id/videos', ah(async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  const b = req.body || {};
  let prompt = String(b.prompt || '').trim();
  if (!prompt) {
    const selectedVideo = projects.selectedText(p.id, 'video_prompt');
    prompt = selectedVideo?.content || '';
  }
  if (!prompt) {
    const latest = projects.texts(p.id).find((t) => t.kind === 'video_prompt');
    prompt = latest?.content || '';
  }
  const task = await pipeline.submitVideoTask({
    projectId: p.id,
    prompt,
    seconds: b.seconds,
    aspectRatio: b.aspect_ratio,
  });
  res.status(201).json(task);
}));

/* ---------- v1.3 成片渲染（镜头视频 + 逐镜旁白 → 完整短片） ---------- */

const RENDER_PARAMS_DEFAULTS = { transition_ms: 600, narration_offset_ms: 500, title_card: true, end_card: true };

// 发起渲染：{transition_ms?, narration_offset_ms?, title_card?, end_card?} → 渲染任务（后台执行）
app.post('/api/projects/:id/render', ah(async (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  if (!renderer.hasFfmpeg()) throw new ApiError(400, '未检测到 ffmpeg（需安装并加入 PATH）才能渲染成片');
  const b = req.body || {};
  const clampInt = (v, lo, hi, dft) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : dft;
  };
  const bgmVol = Number(b.bgm_volume);
  const narrVol = Number(b.narration_volume);
  const params = {
    transition_ms: clampInt(b.transition_ms, 200, 2000, RENDER_PARAMS_DEFAULTS.transition_ms),
    narration_offset_ms: clampInt(b.narration_offset_ms, 0, 3000, RENDER_PARAMS_DEFAULTS.narration_offset_ms),
    title_card: b.title_card === undefined ? RENDER_PARAMS_DEFAULTS.title_card : Boolean(b.title_card),
    end_card: b.end_card === undefined ? RENDER_PARAMS_DEFAULTS.end_card : Boolean(b.end_card),
    // v1.4 BGM
    bgm_volume: Number.isFinite(bgmVol) ? Math.min(Math.max(bgmVol, 0), 1) : 0.35,
    bgm_duck: b.bgm_duck === undefined ? true : Boolean(b.bgm_duck),
    // v1.5 旁白增益
    narration_volume: Number.isFinite(narrVol) ? Math.min(Math.max(narrVol, 0.5), 3) : 1.4,
    // v1.6 字幕烧录
    burn_subtitles: b.burn_subtitles === undefined ? true : Boolean(b.burn_subtitles),
    subtitle_fontsize: clampInt(b.subtitle_fontsize, 24, 72, 42),
    // v1.8 成片方向：显式参数 > 项目画幅 > 默认横屏
    aspect: ['16:9', '9:16'].includes(String(b.aspect))
      ? String(b.aspect)
      : (p.aspect_ratio === '9:16' ? '9:16' : '16:9'),
  };
  const collected = renderer.collectSegments(p.id);
  const ready = collected ? collected.segments.length : 0;
  if (ready < 2) throw new ApiError(400, `至少需要 2 个已完成视频的镜头才能渲染成片（当前 ${ready} 个）`);
  const jobId = renders.insert({ project_id: p.id, params });
  log('info', `项目 #${p.id} 发起渲染任务 #${jobId}（${ready} 镜，叠化 ${params.transition_ms}ms，旁白偏移 ${params.narration_offset_ms}ms）`);
  res.status(201).json(renders.get(jobId));
}));

// 项目渲染任务列表
app.get('/api/projects/:id/render/jobs', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) throw new ApiError(404, '项目不存在');
  res.json({ items: renders.listByProject(p.id) });
});

// 渲染任务详情
app.get('/api/render/jobs/:id', (req, res) => {
  const job = renders.get(req.params.id);
  if (!job) throw new ApiError(404, '渲染任务不存在');
  res.json(job);
});

// 删除渲染任务（渲染中不可删；产物文件尽力清理）
app.delete('/api/render/jobs/:id', (req, res) => {
  const job = renders.get(req.params.id);
  if (!job) throw new ApiError(404, '渲染任务不存在');
  if (job.status === 'rendering') throw new ApiError(400, '渲染进行中，暂不能删除');
  if (job.output_path) {
    try { fs.rmSync(job.output_path, { force: true }); } catch { /* ignore */ }
  }
  renders.remove(job.id);
  res.json({ ok: true });
});

/* ---------- 本地图片静态服务 ---------- */
try { fs.mkdirSync(ARTIFACTS_DIR, { recursive: true }); } catch { /* ignore */ }
app.use('/artifacts', express.static(ARTIFACTS_DIR, { maxAge: '7d' }));

/* ---------------- 静态前端 ---------------- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 错误处理 ---------------- */
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err); // 响应已开始流式输出时交给 Express 默认处理
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON' });
  log('error', `未处理异常: ${err.message}\n${err.stack || ''}`);
  res.status(500).json({ error: '服务器内部错误（详情见「日志」面板）' });
});

/* ---------------- 启动 ---------------- */
const PORT = Number(process.env.PORT) || 8273;

// 确保默认设置存在
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (settings.get(k) === null) settings.set(k, v);
}

// v1.6.1 单实例工作锁：后台工作器（轮询/提交/渲染）全局只允许一份。
// 拿到锁的实例运行工作器；未拿到的仅提供 API，并每 30s 尝试接管（持有者消亡后锁 15s 过期）。
function startWorkers() {
  poller.start();
  submitter.start();
  renderer.start();
}
if (acquireInstanceLock()) {
  startWorkers();
} else {
  log('warn', '检测到另一实例持有工作锁，本实例仅提供 API，后台工作器停用（每 30s 尝试接管）');
  const takeover = setInterval(() => {
    if (acquireInstanceLock()) {
      startWorkers();
      log('info', '工作锁已接管，后台工作器启动');
      clearInterval(takeover);
    }
  }, 30_000);
  takeover.unref?.();
}
setInterval(() => refreshInstanceLock(), 10_000).unref?.();
// 只监听本机回环地址：本地单机工具，不对局域网/公网开放（API Key 存于本地）
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║        Agnes Video 任务控制台 已启动                ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  ➜ 打开:  http://127.0.0.1:${PORT}`);
  console.log(`  ➜ 数据库: ${DB_PATH}`);
  console.log(`  ➜ 默认模型: ${settings.get('model')}（当前限时免费）`);
  console.log('  提示: 请先在页面右上角“设置”中填写你的 Agnes API Key');
  console.log('');
});

function shutdown(signal) {
  log('info', `收到 ${signal}，正在关闭...`);
  poller.stop();
  server.close(() => {
    require('./db').db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 常驻轮询服务的进程级兜底：遗漏的 rejection 记日志不崩；uncaughtException 走优雅退出
process.on('unhandledRejection', (reason) => {
  log('error', `未处理的 Promise rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  log('error', `未捕获异常，进程即将退出: ${err.stack || err.message}`);
  shutdown('uncaughtException');
});

module.exports = { app, server }; // 供冒烟测试使用