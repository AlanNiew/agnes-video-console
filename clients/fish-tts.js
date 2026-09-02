'use strict';
/**
 * fish-tts.js —— Fish Audio 文本转语音客户端
 * 接口（官方文档 https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech）：
 *   POST https://api.fish.audio/v1/tts   同步合成，返回音频流（mp3/wav/opus/pcm）
 *
 * 网络说明：默认直连。若设置了 FISH_PROXY_HOST / FISH_PROXY_PORT 环境变量（如 HTTP 代理 127.0.0.1:7897），
 * 则走 CONNECT 隧道 + TLS（openapi 直连不通时用云服务器代理或本地 Clash 等）。
 * 本机若使用「虚拟网卡/TUN 模式」代理，则直连即可，无需配置。
 */

const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');

const BASE_HOST = 'api.fish.audio';
const REQUEST_TIMEOUT_MS = 180_000; // TTS 同步合成，最长 180s（官方建议秒级，复杂文本更久）

/** 归一化代理配置：支持 'host:port' 或分环境变量 */
function proxyConfig() {
  const raw = process.env.FISH_PROXY || ''; // 形如 "127.0.0.1:7897"
  const host = process.env.FISH_PROXY_HOST || raw.split(':')[0] || '';
  const port = Number(process.env.FISH_PROXY_PORT || raw.split(':')[1] || 0);
  return host && port ? { host, port } : null;
}

/** 通过 HTTP 代理建立 CONNECT 隧道（返回原始 socket；随后由调用方在其上做 TLS） */
function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => {
      sock.write(`CONNECT ${BASE_HOST}:443 HTTP/1.1\r\nHost: ${BASE_HOST}:443\r\n\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx);
      sock.removeListener('data', onData);
      if (/ 200 /.test(head)) resolve(sock);
      else {
        sock.destroy();
        reject(new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

/**
 * 文本转语音（同步）
 * @param {object} o
 * @param {string} o.apiKey    Fish Audio API Key
 * @param {string} o.text      要合成的文本（≤ 2000 字为宜，超长自动分段由平台处理）
 * @param {string} [o.referenceId] 音色模型 id（Fish 音色库 / 自建克隆音色）；缺省用平台默认音色
 * @param {string} [o.model]   's2.1-pro-free'（默认，免费档）/ 's2.1-pro' / 's2-pro' / 's1'
 * @param {number} [o.speed]   语速 0.5–2.0（默认 1）
 * @param {number} [o.temperature] 0–1，默认为空（用平台默认）
 * @param {string} [o.format]  'mp3'(默认) | 'wav' | 'opus' | 'pcm'
 * @returns {Promise<{ok:boolean,status:number,contentType:string,buf:Buffer,raw:string}>}
 */
async function synthesize({
  apiKey,
  text,
  referenceId = null,
  model = 's2.1-pro-free',
  speed,
  temperature,
  format = 'mp3',
}) {
  const body = { text, normalize: true, format };
  if (referenceId) body.reference_id = referenceId;
  if (speed !== undefined && Number.isFinite(Number(speed))) {
    body.prosody = { ...(body.prosody || {}), speed: Number(speed) };
  }
  if (temperature !== undefined && Number.isFinite(Number(temperature))) {
    body.temperature = Number(temperature);
  }
  const payload = JSON.stringify(body);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    model,
    'Content-Length': Buffer.byteLength(payload),
  };

  const proxy = proxyConfig();

  try {
    if (!proxy) {
      // 直连（本机虚拟网卡/TUN 全局代理场景）
      return await directRequest(headers, payload);
    }
    // HTTP 代理 CONNECT 隧道 + TLS
    const raw = await tunnel(proxy.host, proxy.port);
    const tlsSock = tls.connect({ socket: raw, servername: BASE_HOST });
    await new Promise((resolve, reject) => {
      tlsSock.once('secureConnect', resolve);
      tlsSock.once('error', reject);
    });
    return await proxiedRequest(tlsSock, headers, payload);
  } catch (e) {
    return { ok: false, status: 0, contentType: '', buf: null, raw: `网络异常: ${e.message}` };
  }
}

function directRequest(headers, payload) {
  return new Promise((resolve) => {
    const req = https.request({ hostname: BASE_HOST, path: '/v1/tts', method: 'POST', headers }, (res) =>
      collect(res).then((r) => resolve(r)),
    );
    req.on('error', (e) =>
      resolve({ ok: false, status: 0, contentType: '', buf: null, raw: `网络异常: ${e.message}` }),
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('请求超时'));
    });
    req.write(payload);
    req.end();
  });
}

function proxiedRequest(tlsSock, headers, payload) {
  return new Promise((resolve, reject) => {
    // 隧道已是 TLS 加密流 → 用 http.request 在加密 socket 上发应用层请求（避免二次握手）
    const req = http.request(
      { host: BASE_HOST, path: '/v1/tts', method: 'POST', headers, createConnection: () => tlsSock, agent: false },
      (res) => collect(res).then(resolve),
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('请求超时')));
    req.write(payload);
    req.end();
  });
}

function collect(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = res.headers['content-type'] || '';
      const isJson = ct.includes('json') || res.statusCode >= 400;
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300 && !isJson,
        status: res.statusCode,
        contentType: ct,
        buf,
        raw: isJson ? buf.toString('utf8').slice(0, 2000) : '',
      });
    });
    res.on('error', (e) =>
      resolve({ ok: false, status: 0, contentType: '', buf: null, raw: `响应异常: ${e.message}` }),
    );
  });
}

/**
 * 声音广场：浏览社区音色模型（v1.9）
 * GET https://api.fish.audio/model/web?page_size=&page_number=&sort_by=trending|task_count|created_at&language=zh&tag=male&tag=young
 * 认证：Authorization: Bearer <web token>（与 TTS API Key 不同，来自 fish.audio 网页端会话）
 */
async function listWebModels({
  token,
  sortBy = 'trending',
  language = 'zh',
  tags = [],
  pageNumber = 1,
  pageSize = 20,
}) {
  const url = new URL('https://api.fish.audio/model/web');
  url.searchParams.set('page_size', String(Math.min(Math.max(Number(pageSize) || 20, 1), 30)));
  url.searchParams.set('page_number', String(Math.max(Number(pageNumber) || 1, 1)));
  if (sortBy) url.searchParams.set('sort_by', String(sortBy));
  if (language) url.searchParams.set('language', String(language));
  for (const t of tags || []) if (t) url.searchParams.append('tag', String(t));
  const res = await fetch(url, {
    headers: { accept: 'application/json', authorization: 'Bearer ' + String(token || '') },
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !Array.isArray(j.items)) {
    const detail = j && j.message ? j.message : `HTTP ${res.status}`;
    return { ok: false, status: res.status, items: [], error: detail };
  }
  return { ok: true, items: j.items, has_more: Boolean(j.has_more) };
}

module.exports = { synthesize, listWebModels, BASE_HOST, proxyConfig };
