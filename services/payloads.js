'use strict';
/**
 * services/payloads.js —— 请求体校验与上游 payload 构建 + 任务入队（v1.9.1 拆分自 server.js）
 * 纯校验/组装逻辑，不依赖 express（可单测的部分占大头）；
 * submitTask 依赖 db/submitter/logger（入队即触发后台提交）。
 */
const { settings, tasks, DEFAULT_SETTINGS } = require('../db');
const submitter = require('../workers/submitter');
const { log } = require('../core/logger');
const {
  MODELS,
  MODES,
  SECONDS_OK,
  ASPECT_RATIOS,
  IMAGE_MODEL,
  IMAGE_SIZES,
  IMAGE_RATIOS,
  MAX_TEXT_LEN,
  MAX_INPUT_IMAGES,
} = require('../core/constants');
const { ApiError } = require('../core/errors');

/* ---------------- URL 工具 ---------------- */

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

/* ---------------- V2.0 payload ---------------- */

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

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

  const numFrames = Number(b.num_frames ?? 121);
  if (!Number.isInteger(numFrames) || numFrames < 9 || numFrames > 441) {
    throw new ApiError(400, `num_frames 需为 9–441 的整数，收到：${b.num_frames}`);
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
  for (const [k, v] of [
    ['width', width],
    ['height', height],
  ]) {
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
  } else {
    // keyframes
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
      model,
      mode,
      prompt,
      seconds,
      size: sizeStr,
      aspect_ratio: aspectRatio,
      seed,
      image: imageUrl,
      images,
      num_frames: numFrames,
      frame_rate: frameRate,
      width,
      height,
      negative_prompt: negativePrompt || null,
    },
  };
}

/* ---------------- 2.5 家族 payload ---------------- */

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
      model,
      mode,
      prompt,
      seconds,
      size,
      aspect_ratio: aspectRatio,
      seed,
      first_frame: firstFrame,
      last_frame: lastFrame,
      images,
      audios,
      videos,
    },
  };
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

/* ---------------- 图片 payload ---------------- */

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

/* ---------------- 任务入队 ---------------- */

/** 创建任务记录并进入提交队列（v1.3）：
 * 不再同步调用上游 —— 由后台提交器（submitter.js）按 submit_interval_ms 节流提交，
 * 429 / 网络错误自动退避重试，把「限流撞墙」变成「排队等待」。 */
async function submitTask(payload, meta, opts = {}) {
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');

  const id = tasks.insert({
    status: 'queued',
    ...meta,
    request_json: payload,
    project_id: opts.project_id || null,
    shot_id: opts.shot_id || null,
    text_id: opts.text_id || null,
    image_id: opts.image_id || null,
  });
  submitter.kick(id); // 立即唤醒提交器尝试首次提交（是否放行仍受最小间隔约束）
  log('info', `任务 #${id} 已入队（${meta.model}，后台提交器按间隔提交，429 自动重试）`);
  return tasks.get(id);
}

module.exports = {
  isHttpUrl,
  safeUrl,
  cleanUrlList,
  cleanVideoList,
  gcd,
  buildV2Payload,
  buildV25Payload,
  buildPayload,
  buildImagePayload,
  submitTask,
};
