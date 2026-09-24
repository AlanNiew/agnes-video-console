'use strict';
/**
 * services/payloads.js —— 请求体校验与上游 payload 构建（v1.9.1 拆分自 server.js）
 * 纯校验/组装逻辑，不依赖 express 与任何后台 worker（可单测的部分占大头）；
 * 「任务入队」动作在 services/task-queue.js（M2 分层纪律：payloads 不接触提交器）。
 */
const { settings, DEFAULT_SETTINGS } = require('../db');
const {
  MODELS,
  RETIRED_MODELS,
  DREAMINA_MODELS,
  DREAMINA_FALLBACK_VIDEO_MODEL,
  DREAMINA_IMAGE_MODELS,
  DREAMINA_VIDEO_RATIOS,
  DREAMINA_IMAGE_RATIOS,
  DREAMINA_CREDIT_COST,
  DREAMINA_DEFAULT_THRESHOLD,
  providerOf,
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
const {
  FREE_VIDEO_MODEL,
  FREE_IMAGE_MODEL,
  clampFreeSeconds,
  freeVideoSize,
  isVipLevel,
} = require('../core/provider-policy');

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

/** 校验并构建提交给 API 的请求体（按上游 provider / 模型家族分发） */
function buildPayload(body) {
  const b = body || {};
  // 即梦（官方 CLI）与 Agnes 的参数体系完全不同，先按 provider 分流。
  // 注意：必须在 MODELS 兜底之前判断，否则即梦模型会被当作「未知模型」而静默降级为默认 Agnes 模型。
  if (providerOf(b.model) === 'dreamina') return buildDreaminaPayload(b);
  // 已下线模型：明确报错，**不要**静默回退到默认模型 ——
  // 否则旧任务点"重试"会悄悄换模型重投，产物与预期不符且难排查。
  if (b.model && RETIRED_MODELS[b.model]) {
    throw new ApiError(
      400,
      `模型 ${b.model} 已于 ${RETIRED_MODELS[b.model]} 下线，请改用 2.5 系列` +
        '（agnes-video-2.5-flash / agnes-video-2.5）重新提交',
    );
  }
  const model = MODELS[b.model] ? b.model : settings.get('model', DEFAULT_SETTINGS.model);
  const info = MODELS[model];
  if (!info) throw new ApiError(400, `不支持的模型：${model}`);
  return buildV25Payload(b);
}

/* ---------------- 即梦（dreamina CLI）payload ---------------- */

/**
 * 校验即梦视频请求并构建「语义参数」对象（存入 tasks.request_json，由 submitter 转 argv）。
 * 与 Agnes payload 的区别：这里不组装 HTTP body——argv 由 clients/dreamina.js 的 buildVideoArgs
 * 从此对象生成，字段名与 CLI 的 --kebab 参数一一对应。
 * 子命令由入参自动推导：**提供首帧图 → image2video，否则 text2video**（后者更符合直觉）。
 * frames2video（首尾帧）/ multimodal2video（全能参考）尚未接入，显式拒绝而非静默忽略。
 */
function buildDreaminaPayload(b) {
  const model = String(b.model || '').trim();
  const info = DREAMINA_MODELS[model];
  if (!info) throw new ApiError(400, `不支持的即梦模型：${model}`);

  // 首帧图来源：直接传 image，或复用前端 keyframe 模式的 first_frame
  const firstFrame = b.image || b.first_frame || null;
  const subcommand = firstFrame ? 'image2video' : 'text2video';
  const spec = info.specs?.[subcommand];
  if (!spec) {
    const avail = Object.keys(info.specs || {}).join(' / ') || '无';
    throw new ApiError(
      400,
      subcommand === 'image2video'
        ? `模型 ${model} 不支持图生视频（image2video），可用：${avail}；请换用支持首帧的模型`
        : `模型 ${model} 不支持文生视频（text2video），可用：${avail}；该模型需要首帧图`,
    );
  }

  // 未接入的子命令必须显式拒绝，否则用户以为素材生效、实际被静默忽略
  if (b.last_frame) {
    throw new ApiError(400, '即梦暂不支持首尾帧（frames2video）；请只提供首帧图，或改用 Agnes 模型');
  }
  if (b.mode && String(b.mode) === 'reference') {
    throw new ApiError(400, '即梦暂不支持多模态参考（multimodal2video）；请用 text 或 keyframe 模式，或改用 Agnes');
  }

  const prompt = String(b.prompt || '').trim();
  if (!prompt) throw new ApiError(400, '即梦视频生成 prompt 不能为空');
  if (prompt.length > MAX_TEXT_LEN) throw new ApiError(400, `prompt 长度需 ≤ ${MAX_TEXT_LEN}`);

  // 时长：兼容 seconds 别名（与前端/Agnes 的字段习惯保持一致）
  const duration = Number(b.duration ?? b.seconds ?? 5);
  if (!Number.isInteger(duration) || duration < spec.minDuration || duration > spec.maxDuration) {
    throw new ApiError(400, `时长须为 ${spec.minDuration}-${spec.maxDuration} 的整数秒（${model} / ${subcommand}）`);
  }

  // 分辨率：CLI 侧 --video_resolution 为必填项，故此处必须落到合法值
  const resolution = String(b.video_resolution || b.size || spec.resolutions[0]).toLowerCase();
  if (!spec.resolutions.includes(resolution)) {
    throw new ApiError(400, `分辨率须为 ${spec.resolutions.join(' / ')}（${model}）`);
  }

  // 兼容前端视频表单的字段名：该表单发 aspect_ratio，不发 ratio（图片表单发 ratio）
  const rawRatio = b.ratio || b.aspect_ratio;
  let ratio = rawRatio ? String(rawRatio) : null;
  if (ratio && !DREAMINA_VIDEO_RATIOS.includes(ratio)) {
    throw new ApiError(400, `画幅须为 ${DREAMINA_VIDEO_RATIOS.join(' / ')}`);
  }
  // 2.5 的图生视频跟随首帧输出，CLI 会直接拒绝 --ratio：此处主动丢弃（画幅由首帧决定）
  if (ratio && spec.omitRatio) ratio = null;

  return {
    // 存入 tasks.request_json：submitter 直接交给 clients/dreamina.buildVideoArgs 生成 argv。
    // 字段名必须与 buildVideoArgs 的入参（camelCase）严格一致——早期用 snake_case 导致
    // --video_resolution/--model_version 根本没生成，CLI 直接报 required flag not set。
    payload: {
      provider: 'dreamina',
      subcommand,
      modelVersion: info.modelVersion,
      model,
      prompt,
      duration,
      videoResolution: resolution,
      ratio, // null 表示交给 CLI 用默认画幅（或由首帧推断）
      ...(firstFrame ? { image: firstFrame } : {}), // 即梦 CLI 的 --image（首帧，本地路径）
    },
    // 存入 tasks 表列：字段名刻意对齐既有列（seconds / size / aspect_ratio），
    // 使前端任务列表无需任何改动即可正常显示时长与规格
    meta: {
      model,
      // 有首帧 → 图生视频（本系统的 'image' 模式）；否则文生视频
      mode: firstFrame ? 'image' : 'text',
      prompt,
      seconds: duration,
      size: resolution,
      aspect_ratio: ratio,
    },
  };
}

/* ---------------- 图片 payload ---------------- */

/** 校验图片请求并构建 payload（即梦异步任务 / Agnes 同步生成；文生图 / 图生图 / 多图合成） */
function buildImagePayload(b) {
  // 即梦图片为异步任务（submit_id + query_result），参数体系与 Agnes 完全不同，先按模型分流
  if (DREAMINA_IMAGE_MODELS[String(b.model || '')]) return buildDreaminaImagePayload(b);
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
  return {
    payload,
    prompt,
    size,
    ratio: b.ratio !== undefined ? ratio : null,
    inputImages,
    // model 一并返回：路由需据此决定入队模型（此前路由硬编码 IMAGE_MODEL，会覆盖即梦模型）
    model: IMAGE_MODEL,
  };
}

/* ---------------- 即梦图片 payload（异步） ---------------- */

/**
 * 校验即梦图片请求并构建语义参数（存 tasks.request_json，由 image-worker 转 argv）。
 * 与 Agnes 图片的本质差异：即梦为**异步任务**（submit_id + query_result 轮询），
 * 而 Agnes 是同步生成（image-worker 阻塞等待返回）。故 image-worker 对即梦走两阶段状态机。
 */
function buildDreaminaImagePayload(b) {
  const model = String(b.model || '').trim();
  const info = DREAMINA_IMAGE_MODELS[model];
  if (!info) throw new ApiError(400, `不支持的即梦图片模型：${model}`);

  const prompt = String(b.prompt || '').trim();
  if (!prompt) throw new ApiError(400, '即梦图片生成 prompt 不能为空');
  if (prompt.length > MAX_TEXT_LEN) throw new ApiError(400, `prompt 长度需 ≤ ${MAX_TEXT_LEN}`);

  // 分辨率：CLI 侧 --resolution_type 为必填项，故必须落到合法值
  const resolutionType = String(b.resolution_type || b.size || info.resolutions[0]).toLowerCase();
  if (!info.resolutions.includes(resolutionType)) {
    throw new ApiError(400, `分辨率须为 ${info.resolutions.join(' / ')}（${model}）`);
  }

  const ratio = b.ratio ? String(b.ratio) : null;
  if (ratio && !DREAMINA_IMAGE_RATIOS.includes(ratio)) {
    throw new ApiError(400, `画幅须为 ${DREAMINA_IMAGE_RATIOS.join(' / ')}`);
  }

  const count = [1, 2, 3, 4].includes(Number(b.count)) ? Number(b.count) : 1;

  return {
    // 字段名必须与 clients/dreamina.buildImageArgs 的入参（camelCase）严格一致，
    // 否则 --resolution_type / --model_version 等 flag 不会生成（见 buildDreaminaPayload 同名注释）
    payload: {
      provider: 'dreamina',
      subcommand: info.subcommand,
      modelVersion: info.model_version,
      model,
      prompt,
      resolutionType,
      ratio, // null 表示交给 CLI 默认（16:9）
      generateNum: count,
    },
    prompt,
    // 对齐 Agnes 的返回结构（路由用解构取值），size 承载分辨率、ratio 供 tasks 列显示
    size: resolutionType,
    ratio,
    model,
  };
}

/* ---------------- 即梦成本预估与护栏 ---------------- */

/**
 * 预估即梦任务的积分消耗（纯函数，供 /api/dreamina/cost 与前端护栏使用）。
 *
 * 计费模式差异（实测确认）：视频按**秒**计费；图片按**次**计费 —— 一次请求返回 4 张候选，
 * 故图片成本与 `count` 无关（传 generate_num:1 也回 4 张、也只扣 1 次）。
 *
 * @param {string} model 即梦模型 id
 * @param {object} params 与 buildDreamina*Payload 相同的入参（duration / video_resolution / size / count）
 * @returns {{points:number|null, confidence:'measured'|'estimated', breakdown:string}|null}
 *          非即梦模型返回 null；无法预估（未知规格）返回 points: null
 */
function estimateDreaminaCost(model, params = {}) {
  const b = params || {};

  // —— 视频：按秒计费 ——
  const vInfo = DREAMINA_MODELS[model];
  if (vInfo) {
    // 子命令与 buildDreaminaPayload 同规则：有首帧 → image2video，否则 text2video
    const sub = b.image || b.first_frame ? 'image2video' : 'text2video';
    const spec = vInfo.specs?.[sub];
    if (!spec) return { points: null, confidence: 'estimated', breakdown: `${model} 不支持 ${sub}` };
    const resolution = String(b.video_resolution || b.size || spec.resolutions[0]).toLowerCase();
    const duration = Number(b.duration ?? b.seconds ?? 5);
    // v2.6.1：**模型覆盖档优先**——同一分辨率下不同代际单价不同（实测 seedance2.0 720p = 8 积分/秒，
    // 而 seedance2.0fast = 5 积分/秒），只按分辨率取单一值会低报 60%。
    const row = DREAMINA_CREDIT_COST.videoByModel?.[model]?.[resolution] || DREAMINA_CREDIT_COST.video[resolution];
    if (!row) return { points: null, confidence: 'estimated', breakdown: `未知分辨率 ${resolution}` };
    return {
      points: row.perSecond * duration,
      confidence: row.source,
      breakdown: `${model} · ${resolution} · ${duration}s × ${row.perSecond} 积分/秒`,
    };
  }

  // —— 图片：按次计费（与 count 无关） ——
  const iInfo = DREAMINA_IMAGE_MODELS[model];
  if (iInfo) {
    const resolution = String(b.resolution_type || b.size || iInfo.resolutions[0]).toLowerCase();
    const entry = DREAMINA_CREDIT_COST.image[model]?.perRequest?.[resolution];
    if (!entry) return { points: null, confidence: 'estimated', breakdown: `未知规格 ${resolution}` };
    // 单价表按「档位」记录 {points, source}——source 精确到分辨率，
    // 便于逐步把实测值替换掉推断值，而不影响同模型其它档位的置信标记
    return {
      points: entry.points,
      confidence: entry.source,
      breakdown: `${resolution} · 按次计费（1 次约 4 张候选）`,
    };
  }

  return null; // 非即梦模型：不参与成本护栏
}

/**
 * 成本护栏判定：按预估积分分三档（见 docs/DREAMINA_CLI_PLAN.md 2.2）。
 *   pass    —— 预估 ≤ 阈值，直接提交（无打扰）
 *   confirm —— 预估 > 阈值，前端需弹窗确认
 *   block   —— 预估 > 剩余积分，禁止提交
 *
 * 无法预估（未知规格）时按最保守处理，返回 confirm。
 *
 * v2.6.1：三档语义**保持不变**（前端与 e2e 依赖），额外返回**回退建议**（additive 字段）：
 *   `free_model`        —— 免费档（Agnes）等效模型
 *   `fallback`          —— 命中"该走免费档"时给出 {model, reason}（额度不足 / 账户无 VIP）
 * 调用方（前端护栏、worker）据此把同一份创意改投免费档，而不是把制作卡死。
 *
 * @param {string} model
 * @param {object} params
 * @param {{threshold?:number, remainingCredit?:number|null, vipLevel?:string}} [opts]
 */
function checkDreaminaGuard(model, params = {}, opts = {}) {
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : DREAMINA_DEFAULT_THRESHOLD;
  const remaining = opts.remainingCredit === undefined ? null : opts.remainingCredit;
  const est = estimateDreaminaCost(model, params);

  if (!est) return null; // 非即梦模型：不套护栏
  const isVideo = Boolean(DREAMINA_MODELS[model]);
  const freeModel = isVideo ? FREE_VIDEO_MODEL : FREE_IMAGE_MODEL;
  const base = {
    points: est.points,
    confidence: est.confidence,
    breakdown: est.breakdown,
    threshold,
    remaining,
    kind: isVideo ? 'video' : 'image',
    free_model: freeModel,
  };

  if (est.points === null) return { ...base, level: 'confirm' }; // 无法预估 → 保守确认
  if (remaining !== null && Number.isFinite(Number(remaining)) && est.points > Number(remaining)) {
    return { ...base, level: 'block', fallback: { model: freeModel, reason: 'insufficient-credit' } };
  }
  // 账户无 VIP：即梦付费档不该由本账户承担 → 给出回退建议（level 仍按额度档位，前端据此提示）
  if (opts.vipLevel !== undefined && !isVipLevel(opts.vipLevel)) {
    const level = est.points > threshold ? 'confirm' : 'pass';
    return { ...base, level, fallback: { model: freeModel, reason: 'not-vip' } };
  }
  if (est.points > threshold) return { ...base, level: 'confirm' };
  return { ...base, level: 'pass' };
}

/**
 * 即梦任务 → 免费档（Agnes）任务映射（纯函数）。
 *
 * 用途：积分不足 / 生成失败 / 非 VIP / 环境未就绪时，把**同一份创意**改投免费档，
 * 由调用方把返回值写回 tasks 行（model + request_json），制作不中断。
 *
 * 映射规则：
 *   - 提示词原样保留（改投不降级创意）；
 *   - 视频时长钳到免费档 4–12s；分辨率落到 Flash 仅支持的 720P；
 *   - 首帧**只在是公网 http(s) URL 时**保留（转 `keyframe` 模式）；本地路径 Agnes 取不到 → 降级纯文生并记 note；
 *   - 图片按次计费与 count 无关，count 原样带回。
 *
 * @param {'video'|'image'} kind
 * @param {object} job 任务行（读 prompt / seconds / size / aspect_ratio / request_json）
 * @returns {{model:string,size:string,seconds?:string,aspect_ratio?:string,request_json:object,notes:string[]}|null}
 *          无提示词可映射时返回 null
 */
function dreaminaToAgnes(kind, job = {}) {
  const rj = job.request_json || {};
  const prompt = String(job.prompt || rj.prompt || '').trim();
  if (!prompt) return null;
  const notes = [];

  if (kind === 'image') {
    const raw = String(job.size || '').toUpperCase();
    const size = IMAGE_SIZES.includes(raw) ? raw : '1K';
    if (raw && size !== raw) notes.push(`分辨率 ${job.size} → ${size}`);
    const ratio = IMAGE_RATIOS.includes(String(job.aspect_ratio || '')) ? String(job.aspect_ratio) : '1:1';
    const count = [1, 2, 3, 4].includes(Number(rj.count)) ? Number(rj.count) : 1;
    return {
      model: FREE_IMAGE_MODEL,
      size,
      ratio,
      request_json: {
        model: FREE_IMAGE_MODEL,
        prompt,
        size,
        ratio,
        extra_body: { response_format: 'url' },
        count,
        image_kind: rj.image_kind || null,
      },
      notes,
    };
  }

  // —— 视频 ——
  const rawSeconds = job.seconds ?? rj.duration;
  const seconds = clampFreeSeconds(rawSeconds);
  if (String(rawSeconds) !== String(seconds)) notes.push(`时长 ${rawSeconds}s → ${seconds}s（免费档 4–12s）`);
  const rawSize = job.size || rj.videoResolution;
  const size = freeVideoSize(rawSize && String(rawSize).toLowerCase() === '720p' ? '720P' : rawSize);
  if (rawSize && String(rawSize).toLowerCase() !== size.toLowerCase()) notes.push(`分辨率 ${rawSize} → ${size}`);
  const aspect_ratio = ASPECT_RATIOS.includes(String(job.aspect_ratio || '')) ? String(job.aspect_ratio) : '16:9';
  const frame = isHttpUrl(rj.image) ? String(rj.image).trim() : '';
  if (rj.image && !frame) notes.push('首帧为本地路径/不可达 URL → 降级为纯文生');

  const request_json = {
    model: FREE_VIDEO_MODEL,
    prompt,
    mode: frame ? 'keyframe' : 'text',
    seconds: String(seconds),
    size,
    aspect_ratio,
    n: 1,
  };
  if (frame) request_json.first_frame = frame;
  return { model: FREE_VIDEO_MODEL, size, seconds: String(seconds), aspect_ratio, request_json, notes };
}

/**
 * v2.6.7 **反向回退映射**：Agnes 任务 → 即梦任务（免费档长时间排队失败时改投即梦继续制作）。
 * 与 `dreaminaToAgnes` 对称、方向相反；差异点必须守住：
 *
 *   - **带参考图的任务不自动改投**：Agnes 的 `reference`（角色一致性）与即梦 `image2video`
 *     （首帧动画）语义不同 —— 自动改投会把"参考"变成"首帧"，画面意图被改变，宁可停在原处等人工；
 *   - 分辨率一律落该模型 spec 的首个合法值（`seedance2.0mini` 仅 720p）；
 *   - 时长按目标模型 spec 钳制（Mini 4–15s），并记 notes 说明改动；
 *   - 组装走 `buildDreaminaPayload`，保证与手动提交即梦**同一套校验**（不另写一份参数逻辑）。
 *
 * @param {object} job 任务行（读 prompt / seconds / size / aspect_ratio / request_json）
 * @param {string} [model] 目标即梦模型（默认 `DREAMINA_FALLBACK_VIDEO_MODEL`）
 * @returns {{ok:true,model:string,size:string,seconds:string,aspect_ratio:string,request_json:object,notes:string[]}
 *          |{ok:false,reason:string}}
 */
function agnesToDreamina(job = {}, model = DREAMINA_FALLBACK_VIDEO_MODEL) {
  const rj = job.request_json || {};
  const prompt = String(job.prompt || rj.prompt || '').trim();
  if (!prompt) return { ok: false, reason: 'no-prompt' };

  const refs = [...(Array.isArray(rj.images) ? rj.images : []), rj.image].filter(
    (x) => x !== undefined && x !== null && x !== '',
  );
  if (refs.length) return { ok: false, reason: 'has-reference-images' };

  const info = DREAMINA_MODELS[model];
  if (!info) return { ok: false, reason: 'unknown-model' };
  const spec = info.specs?.text2video;
  if (!spec) return { ok: false, reason: 'unsupported-subcommand' };

  const notes = [];
  const rawSeconds = Number(job.seconds ?? rj.seconds ?? rj.duration ?? 5);
  let seconds = Math.round(Number.isFinite(rawSeconds) ? rawSeconds : 5);
  if (seconds < spec.minDuration || seconds > spec.maxDuration) {
    const clamped = Math.min(Math.max(seconds, spec.minDuration), spec.maxDuration);
    notes.push(`时长 ${seconds}s → ${clamped}s（${model} 支持 ${spec.minDuration}–${spec.maxDuration}s）`);
    seconds = clamped;
  }

  const size = spec.resolutions[0];
  const rawSize = String(job.size || rj.size || rj.video_resolution || '');
  if (rawSize && rawSize.toLowerCase() !== size) notes.push(`分辨率 ${rawSize} → ${size}`);

  const rawRatio = String(job.aspect_ratio || rj.aspect_ratio || '');
  const aspect_ratio = DREAMINA_VIDEO_RATIOS.includes(rawRatio) ? rawRatio : '16:9';
  if (rawRatio && aspect_ratio !== rawRatio) notes.push(`画幅 ${rawRatio} → ${aspect_ratio}`);

  try {
    const { payload } = buildDreaminaPayload({
      model,
      prompt,
      seconds: String(seconds),
      video_resolution: size,
      aspect_ratio,
    });
    return { ok: true, model, size, seconds: String(seconds), aspect_ratio, request_json: payload, notes };
  } catch (e) {
    // 即梦侧校验不通过（如参数组合不支持）→ 不改投，保留原失败状态等人工
    return { ok: false, reason: e instanceof ApiError ? 'bad-args' : 'bad-args' };
  }
}

module.exports = {
  isHttpUrl,
  safeUrl,
  cleanUrlList,
  cleanVideoList,
  buildV25Payload,
  buildPayload,
  buildDreaminaPayload,
  buildImagePayload,
  buildDreaminaImagePayload,
  estimateDreaminaCost,
  checkDreaminaGuard,
  dreaminaToAgnes,
  agnesToDreamina,
};
