'use strict';
/**
 * zhipu.js —— 智谱 BigModel（CogVideoX）视频客户端（v2.7）
 *
 * 接口（官方文档 https://docs.bigmodel.cn/cn/guide/models/free/cogvideox-flash）：
 *   POST {base}/api/paas/v4/videos/generations       创建任务（异步，返回 task id）
 *   GET  {base}/api/paas/v4/async-result/{task_id}   查询结果（SUCCESS 时给 video_result[].url）
 *
 * 为什么单独一个客户端而不是复用 clients/agnes.js：
 *   两家信封相似但是**协议不同**（路径、鉴权无关但响应字段、状态枚举、产物位置都不同）。
 *   硬合会造成大量 if 分支，反而更容易在"未知响应"上静默出错。这里保持与 agnes.js 同一
 *   `{ ok, status, statusText, data, raw }` 信封，上层 worker 就能用同一种错误处理骨架。
 *
 * 纯函数（extractTaskId / extractVideoUrl / normalizeStatus / classifyError）不碰网络，
 * 便于单测覆盖上游字段漂移。
 */
const { ZHIPU_DEFAULT_BASE_URL } = require('../core/constants');

const REQUEST_TIMEOUT_MS = 30_000;
// 创建接口要等上游排队入队，实测比查询慢，超时给宽一点（免费档高峰期更明显）
const CREATE_TIMEOUT_MS = 60_000;

/** 归一化 base_url：允许粘贴根地址 / 完整接口地址 / 裸域名，统一回到 https://host */
function normalizeBaseUrl(raw) {
  let url = String(raw || '')
    .trim()
    .replace(/\/+$/, '');
  if (!url) url = ZHIPU_DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // 用户可能直接粘贴文档里的完整路径（…/api/paas/v4/videos/generations），统一剥到根
  url = url.replace(/\/api\/paas\/v4(\/.*)?$/i, '');
  return url;
}

/** 统一的 fetch 包装：返回 { ok, status, statusText, data, raw }（与 clients/agnes.js 同构） */
async function request(method, url, { apiKey, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null; // 非 JSON 响应（网关 HTML 错误页等）
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, data, raw: raw.slice(0, 2000) };
}

const zhipu = {
  normalizeBaseUrl,

  /** 创建视频任务：POST {base}/api/paas/v4/videos/generations */
  async createTask({ apiKey, baseUrl, payload }) {
    const url = `${normalizeBaseUrl(baseUrl)}/api/paas/v4/videos/generations`;
    return request('POST', url, { apiKey, body: payload, timeoutMs: CREATE_TIMEOUT_MS });
  },

  /** 查询任务：GET {base}/api/paas/v4/async-result/{task_id} */
  async queryTask({ apiKey, baseUrl, taskId }) {
    const url = `${normalizeBaseUrl(baseUrl)}/api/paas/v4/async-result/${encodeURIComponent(String(taskId))}`;
    return request('GET', url, { apiKey });
  },

  extractTaskId,
  extractVideoUrl,
  normalizeStatus,
  classifyError,
};

/**
 * 取任务 id。
 * 注意：响应里的 request_id 是**单次请求**的链路 id，不是任务 id —— 用它去查 async-result
 * 必然 404，故这里只认 id / task_id。
 */
function extractTaskId(data) {
  if (!data || typeof data !== 'object') return null;
  const cand = data.id || data.task_id || data.taskId;
  return cand === undefined || cand === null || cand === '' ? null : String(cand);
}

/**
 * 取视频地址：上游字段历史上漂移过（video_result[].url / video_url / url / result.url），
 * 逐层兜底并校验 http(s)，避免把异常字符串塞进前端链接。
 */
function extractVideoUrl(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    () => data.video_result?.[0]?.url,
    () => data.data?.video_result?.[0]?.url,
    () => data.result?.video_result?.[0]?.url,
    () => data.video_result?.[0]?.video_url,
    () => data.video_url,
    () => data.url,
    () => data.result?.url,
    () => data.data?.url,
    () => (Array.isArray(data.videos) ? data.videos[0]?.url : undefined),
  ];
  for (const pick of candidates) {
    let v;
    try {
      v = pick();
    } catch {
      v = undefined;
    }
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return null;
}

/**
 * 状态归一化：智谱用大写枚举 PROCESSING / SUCCESS / FAIL → 本系统四态。
 * 未知值返回 null（调用方按 queued 继续轮询，**绝不**把未知状态当失败）。
 */
function normalizeStatus(data) {
  const raw = String((data && (data.task_status || data.status)) || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (['success', 'succeeded', 'completed', 'done', 'finished'].includes(raw)) return 'completed';
  if (['fail', 'failed', 'error', 'cancelled', 'canceled'].includes(raw)) return 'failed';
  if (['processing', 'running', 'in_progress', 'generating', 'inprogress'].includes(raw)) return 'in_progress';
  if (['pending', 'queued', 'waiting', 'created'].includes(raw)) return 'queued';
  return null;
}

/**
 * 错误分类（纯函数）：提交器/轮询器据此决定「退避重试」还是「判死」。
 * 分类依据 = HTTP 状态码 + 智谱错误码/文案（错误码文档分散且会变，故文案兜底）。
 * @returns {{kind:'auth'|'quota'|'bad-args'|'content-policy'|'rate-limit'|'queue-full'|'not-found'|'server'|'net'|'unknown', retryable:boolean, message:string}}
 */
function classifyError(r) {
  const status = Number((r && r.status) || 0);
  const data = (r && r.data) || {};
  const code = String((data.error && data.error.code) ?? data.code ?? '').trim();
  const msg = String((data.error && data.error.message) ?? data.message ?? data.msg ?? '').trim();
  const text = `${code} ${msg}`.toLowerCase();
  const message = (msg || code || (r && r.statusText) || `HTTP ${status}`).slice(0, 300);

  const kindOf = (kind, retryable) => ({ kind, retryable, message });

  if (status === 401 || status === 403 || /认证|鉴权|invalid.*(key|token)|unauthorized/.test(text)) {
    return kindOf('auth', false);
  }
  if (/余额|欠费|balance|insufficient|quota|arrears/.test(text)) return kindOf('quota', false);
  if (/内容|敏感|安全审核|content[_ ]?filter|policy|safety/.test(text)) return kindOf('content-policy', false);
  if (status === 429 || /并发|频率|限流|rate[_ ]?limit|too many requests|concurren/.test(text)) {
    return kindOf('rate-limit', true);
  }
  if (/队列|queue|busy|系统繁忙|server is busy/.test(text)) return kindOf('queue-full', true);
  if (status === 404) return kindOf('not-found', false);
  if (status >= 500) return kindOf('server', true);
  if (status >= 400) return kindOf('bad-args', false);
  return kindOf('unknown', false);
}

module.exports = zhipu;
