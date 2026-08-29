'use strict';
/**
 * server.js —— Agnes Video 任务控制台 服务端入口
 * Express + SQLite + 后台轮询器 + 静态前端
 */
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { settings, tasks, projects, tx, DEFAULT_SETTINGS, DB_PATH } = require('./db');
const agnes = require('./agnes');
const poller = require('./poller');
const { createPipelineService } = require('./pipeline');
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
  },
  'agnes-video-2.5': {
    family: 'v25', sizes: ['720P', '960P', '2K'], free: false, short: '2.5',
    hint: '付费 · 720P/960P/2K · 支持视频参考',
    label: 'Agnes Video 2.5（付费）',
  },
  'agnes-video-v2.0': {
    family: 'v2', sizes: [], free: true, short: 'V2.0（旧）', deprecated: true,
    hint: '旧模型 · 已从界面下架（后端兼容保留）',
    label: 'Agnes Video V2.0（旧模型 · 下架）',
  },
};
const MODES = ['text', 'keyframe', 'reference'];
const V2_MODES = ['text', 'image', 'keyframes'];
const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const SECONDS_OK = Array.from({ length: 9 }, (_, i) => String(i + 4)); // '4'..'12'
const PROJECT_STATUSES = ['draft', 'copy_done', 'character_done', 'video_submitted'];
const SHOT_COUNTS = ['auto', '3', '5', '8'];   // 分镜生成可选镜头数
const SHOT_MODES = ['reference', 'text'];      // 镜头模式（keyframe 为 M2+ 预留）
const MAX_SHOTS = 20;                          // 每项目镜头数上限

/* 流水线模型（最新免费三件套，M1 固定值） */
const LLM_MODEL = 'agnes-2.5-flash';        // 文本：提示词优化/文案
const IMAGE_MODEL = 'agnes-image-2.1-flash'; // 图片：角色/场景
const IMAGE_SIZES = ['1K', '2K', '3K', '4K'];
const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];
const ARTIFACTS_DIR = path.join(
  process.env.DATA_DIR || path.join(__dirname, 'data'),
  'artifacts'
);

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

/** 提交任务到 Agnes API 并落库（供创建 / 重试 / 流水线视频复用） */
async function submitTask(payload, meta, opts = {}) {
  const apiKey = settings.get('api_key', '');
  const baseUrl = settings.get('base_url', DEFAULT_SETTINGS.base_url);
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');

  const id = tasks.insert({
    status: 'queued', ...meta, request_json: payload,
    project_id: opts.project_id || null,
    shot_id: opts.shot_id || null,
    text_id: opts.text_id || null,
    image_id: opts.image_id || null,
  });

  let r;
  try {
    r = await agnes.createTask({ apiKey, baseUrl, payload });
  } catch (e) {
    tasks.update(id, { status: 'submit_error', error_message: `提交网络异常：${e.message}` });
    log('error', `任务 #${id} 提交网络异常: ${e.message}`);
    throw new ApiError(502, `提交任务时网络异常：${e.message}`);
  }

  if (!r.ok) {
    const detail = r.data?.detail || r.data?.error?.message || r.raw || `HTTP ${r.status}`;
    tasks.update(id, { status: 'submit_error', error_message: `提交失败（${r.status}）：${String(detail).slice(0, 500)}`, submit_response: r.data });
    log('error', `任务 #${id} 创建失败（${r.status}）：${detail}`);
    throw new ApiError(r.status >= 400 && r.status < 500 ? 400 : 502, `创建任务失败（${r.status}）：${String(detail).slice(0, 500)}`);
  }

  const j = r.data || {};
  tasks.update(id, {
    task_id: j.task_id || j.id || null,
    video_id: j.video_id || null,
    submit_response: j,
    status: /^(queued|in_progress|completed|failed)$/.test(j.status) ? j.status : 'queued',
    progress: Number.isFinite(j.progress) ? Number(j.progress) : 0,
    metadata_url: safeUrl(j.metadata?.url || j.url),
  });
  log('info', `任务 #${id} 创建成功 video_id=${j.video_id || '(null)'} status=${j.status || 'queued'}`);
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

// 获取设置（API Key 永远只返回掩码）
app.get('/api/settings', (req, res) => {
  const key = settings.get('api_key', '');
  res.json({
    api_key_set: Boolean(key),
    api_key_masked: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : '',
    base_url: settings.get('base_url', DEFAULT_SETTINGS.base_url),
    model: settings.get('model', DEFAULT_SETTINGS.model),
    poll_interval_ms: Number(settings.get('poll_interval_ms', DEFAULT_SETTINGS.poll_interval_ms)),
    max_active_minutes: Number(settings.get('max_active_minutes', DEFAULT_SETTINGS.max_active_minutes)),
    submit_interval_ms: Number(settings.get('submit_interval_ms', DEFAULT_SETTINGS.submit_interval_ms)),
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
app.delete('/api/tasks/:id', (req, res) => {
  if (!tasks.remove(req.params.id)) throw new ApiError(404, '任务不存在');
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

/** 文案生成系统提示词：严格输出结构化 JSON */
const SCRIPT_SYSTEM_PROMPT = `你是资深影视创作者助理。根据用户的一句话创意，输出一份可直接用于 AI 出片的结构化文案。
只输出一个 JSON 对象（不要 markdown 代码块、不要注释），字段如下：
{
  "script": "故事梗概，80~150 字，交代人物、目标、冲突与氛围",
  "video_prompt": "视频生成提示词，中文，按顺序描述：主体与场景→动作与变化→镜头语言→视觉风格→声音与节奏；若后续会引用角色图，请以\\"以 <Picture 1> 中的角色为参考，保持其外观一致\\"开头或包含该要求；长度 80~180 字",
  "character_desc": "主角外观设定，适合生成角色立绘：性别年龄、发型发色、五官气质、服装配色、身材体型、有无配饰，100 字内",
  "scene_desc": "主要场景描述：环境类型、时间光线、色调氛围，80 字内"
}`;

/** 分镜生成系统提示词：输出 shots 数组的结构化 JSON（mock 测试按 "shots" 契约标记识别） */
const STORYBOARD_SYSTEM_PROMPT = `你是资深影视分镜师。根据用户的一句话创意，把影片拆解为多个连续镜头的分镜脚本。
只输出一个 JSON 对象（不要 markdown 代码块、不要注释），字段如下：
{
  "shots": [
    {
      "seq": 1,
      "title": "镜头标题，10 字内，概括本镜头画面",
      "video_prompt": "该镜头的视频生成提示词，中文 80~150 字，按顺序描述：主体与场景→动作与变化→镜头语言→视觉风格→声音与节奏；必须以\\"以 <Picture 1> 中的角色为参考，保持其外观一致\\"开头以保持角色一致",
      "seconds": "5"
    }
  ]
}
要求：镜头之间动作与镜头语言连贯，覆盖从开场到收尾的完整叙事；seconds 只能是 "4"~"12" 的字符串；镜头数量遵循用户指定数量（未指定则按叙事需要 3~8 个）。`;

/** 下载远程图片到本地 artifacts 做永久备份（失败不阻塞） */
async function downloadArtifact(remoteUrl) {
  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const ct = res.headers.get('content-type') || '';
    let ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('jpeg') || ct.includes('jpg') ? '.jpg' : '.png';
    const name = `a${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`;
    fs.writeFileSync(path.join(ARTIFACTS_DIR, name), buf);
    return { local_path: path.join(ARTIFACTS_DIR, name), local_url: `/artifacts/${name}` };
  } catch {
    return null;
  }
}

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
  // 落库到项目（若指定），每个 kind 最新版本自动选中
  let texts = null;
  if (b.project_id) {
    for (const kind of ['script', 'video_prompt', 'character_desc', 'scene_desc']) {
      if (!result[kind]) continue;
      const tid = projects.addText({ project_id: b.project_id, kind, content: result[kind], model: LLM_MODEL });
      projects.selectText(tid, kind, b.project_id);
    }
    projects.update(b.project_id, { status: 'copy_done' });
    texts = projects.texts(b.project_id);
    log('info', `项目 #${b.project_id} 文案生成完成`);
  }
  res.json({ parsed: true, result, texts, model: r.data?.model || LLM_MODEL });
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
  if (b.project_id) {
    // storyboard 整体版本落库（可回溯/选用历史），shots 工作副本整体重建
    const content = JSON.stringify({ shots: normalized });
    const tid = projects.addText({ project_id: b.project_id, kind: 'storyboard', content, model: LLM_MODEL });
    projects.selectText(tid, 'storyboard', b.project_id);
    projects.replaceShots(b.project_id, normalized);
    shotsOut = projects.shots(b.project_id);
    texts = projects.texts(b.project_id);
    log('info', `项目 #${b.project_id} 分镜生成完成（${normalized.length} 个镜头）`);
  } else {
    shotsOut = normalized;
  }
  res.json({ parsed: true, shots: shotsOut, texts, model: r.data?.model || LLM_MODEL });
}));

/* ---------- 图片 ---------- */

// 图片生成（文生图 / 图生图，同步）
app.post('/api/images/generate', ah(async (req, res) => {
  const { payload, prompt, size, ratio, inputImages } = buildImagePayload(req.body);
  const b = req.body || {};
  const kind = ['character', 'scene'].includes(b.kind) ? b.kind : 'character';
  if (b.project_id !== undefined && !projects.get(b.project_id)) throw new ApiError(404, '项目不存在');
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
  let r;
  try {
    r = await agnes.generateImage({
      apiKey,
      baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
      payload,
    });
  } catch (e) {
    throw new ApiError(504, `图片生成超时或网络异常（${e.message}）`);
  }
  if (!r.ok) {
    const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
    throw new ApiError(r.status >= 400 && r.status < 500 ? 400 : 502, `图片生成失败（${r.status}）：${String(detail).slice(0, 400)}`);
  }
  const remoteUrl = r.data?.data?.[0]?.url;
  if (!remoteUrl) throw new ApiError(502, '图片生成响应中未找到 url（请在 extra_body.response_format 指定 url）');
  // 本地备份（不阻塞）
  const backup = await downloadArtifact(remoteUrl);
  let image = null;
  if (b.project_id) {
    const imgId = projects.addImage({
      project_id: b.project_id, kind, prompt, remote_url: remoteUrl,
      local_path: backup?.local_path || null, size, ratio, model: IMAGE_MODEL,
    });
    projects.selectImage(imgId, kind, b.project_id);
    if (kind === 'character') projects.update(b.project_id, { status: 'character_done' });
    image = projects.images(b.project_id).find((x) => x.id === imgId) || null;
    log('info', `项目 #${b.project_id} ${kind === 'character' ? '角色图' : '场景图'}生成完成 #${imgId}`);
  }
  res.json({
    remote_url: remoteUrl,
    local_url: backup?.local_url || null,
    size, ratio,
    image,
  });
}));

// 删除项目图片记录
app.delete('/api/images/:id', (req, res) => {
  if (!projects.removeImage(req.params.id)) throw new ApiError(404, '图片记录不存在');
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
  });
  res.status(201).json(projects.shots(p.id).find((s) => s.id === id));
});

// 编辑镜头（标题/提示词/时长；归属校验防跨项目越权）
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
    prompt: shot.video_prompt,
    seconds: b.seconds || shot.seconds,
    aspectRatio: b.aspect_ratio,
    shotId: shot.id,
  });
  res.status(201).json(task);
}));

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

poller.start();
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