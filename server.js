'use strict';
/**
 * server.js —— Agnes Video 任务控制台 服务端入口
 * Express + SQLite + 后台轮询器 + 静态前端
 */
const path = require('node:path');
const express = require('express');
const { settings, tasks, DEFAULT_SETTINGS, DB_PATH } = require('./db');
const agnes = require('./agnes');
const poller = require('./poller');
const { log, recent: recentLogs } = require('./logger');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------------- 常量 ---------------- */

const MODELS = {
  'agnes-video-2.5-flash': { family: 'v25', sizes: ['720P'], free: true, label: 'Agnes Video 2.5 Flash（免费）' },
  'agnes-video-2.5':       { family: 'v25', sizes: ['720P', '960P', '2K'], free: false, label: 'Agnes Video 2.5（付费）' },
  'agnes-video-v2.0':      { family: 'v2', free: true, label: 'Agnes Video V2.0（免费 · 文生/图生/关键帧）' },
};
const MODES = ['text', 'keyframe', 'reference'];
const V2_MODES = ['text', 'image', 'keyframes'];
const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const SECONDS_OK = Array.from({ length: 9 }, (_, i) => String(i + 4)); // '4'..'12'

/* ---------------- 工具函数 ---------------- */

/** 简单 URL 校验（必须 http/https） */
function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
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

/** 提交任务到 Agnes API 并落库（供创建 / 重试复用） */
async function submitTask(payload, meta) {
  const apiKey = settings.get('api_key', '');
  const baseUrl = settings.get('base_url', DEFAULT_SETTINGS.base_url);
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');

  const id = tasks.insert({
    status: 'queued', ...meta, request_json: payload,
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
    metadata_url: j.metadata?.url || null,
  });
  log('info', `任务 #${id} 创建成功 video_id=${j.video_id || '(null)'} status=${j.status || 'queued'}`);
  return tasks.get(id);
}

/* ---------------- API 路由 ---------------- */

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
  let n = 0;
  for (const t of [...failed, ...fe]) if (tasks.remove(t.id)) n++;
  res.json({ ok: true, removed: n });
});

// 日志（内存环形缓冲）
app.get('/api/logs', (req, res) => res.json({ items: recentLogs(200) }));

/* ---------------- 静态前端 ---------------- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 错误处理 ---------------- */
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON' });
  log('error', `未处理异常: ${err.message}\n${err.stack || ''}`);
  res.status(500).json({ error: `服务器内部错误：${err.message}` });
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

module.exports = { app, server }; // 供冒烟测试使用