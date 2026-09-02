'use strict';
/**
 * agnes.js —— Agnes AI 视频 API 客户端
 * 接口（依据官方文档 https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash）：
 *   POST /v1/videos                         创建任务
 *   GET  /agnesapi?video_id=&model_name=    查询任务
 */

const REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 180_000; // 图片同步生成 30–180s（官方建议 60–360s）
const CHAT_TIMEOUT_MS = 60_000; // 文本生成最长 60s

/** 归一化 base_url：去掉尾部斜杠与 /v1 后缀（用户可能直接粘贴文档里的 AGNES_BASE_URL） */
const { DEFAULT_BASE_URL } = require('../core/config');

function normalizeBaseUrl(raw) {
  let url = String(raw || '')
    .trim()
    .replace(/\/+$/, '');
  if (!url) url = DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/v1$/, '');
  return url;
}

/** 统一的 fetch 包装：返回 { ok, status, statusText, data, raw } */
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
    data = null; // 非 JSON 响应（如 HTML 错误页）
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, data, raw: raw.slice(0, 2000) };
}

const agnes = {
  normalizeBaseUrl,

  /** 创建视频任务：POST {base}/v1/videos */
  async createTask({ apiKey, baseUrl, payload }) {
    const url = `${normalizeBaseUrl(baseUrl)}/v1/videos`;
    return request('POST', url, { apiKey, body: payload });
  },

  /** 查询任务：GET {base}/agnesapi?video_id=...&model_name=... */
  async queryTask({ apiKey, baseUrl, videoId, model }) {
    const url =
      `${normalizeBaseUrl(baseUrl)}/agnesapi` +
      `?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model || 'agnes-video-2.5')}`;
    return request('GET', url, { apiKey });
  },

  /** 文本生成（OpenAI 兼容 chat completions）：POST {base}/v1/chat/completions */
  async chatComplete({ apiKey, baseUrl, model, messages, temperature, max_tokens }) {
    const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
    const body = { model, messages };
    if (temperature !== undefined) body.temperature = temperature;
    if (max_tokens !== undefined) body.max_tokens = max_tokens;
    return request('POST', url, { apiKey, body, timeoutMs: CHAT_TIMEOUT_MS });
  },

  /** 图片生成（同步，可能耗时较长）：POST {base}/v1/images/generations */
  async generateImage({ apiKey, baseUrl, payload }) {
    const url = `${normalizeBaseUrl(baseUrl)}/v1/images/generations`;
    return request('POST', url, { apiKey, body: payload, timeoutMs: IMAGE_TIMEOUT_MS });
  },
};

module.exports = agnes;
