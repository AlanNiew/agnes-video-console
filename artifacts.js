'use strict';
/**
 * artifacts.js —— 本地产物归档（v1.3 从 server.js 抽出，供 server / poller 共用）
 * 图片/视频/音频等远程产物下载到 data/artifacts 做永久备份（平台远端链接会过期）
 */
const path = require('node:path');
const fs = require('node:fs');

const ARTIFACTS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'artifacts');

const EXT_BY_CONTENT_TYPE = [
  ['.png', 'png'],
  ['.webp', 'webp'],
  ['.jpg', 'jpeg'],
  ['.jpg', 'jpg'],
  ['.mp4', 'mp4'],
  ['.webm', 'webm'],
  ['.mp3', 'mpeg'],
  ['.mp3', 'mp3'],
  ['.wav', 'wav'],
  ['.ogg', 'ogg'],
];

function extFor(contentType, fallback = '.png') {
  const ct = String(contentType || '').toLowerCase();
  for (const [ext, type] of EXT_BY_CONTENT_TYPE) if (ct.includes(type)) return ext;
  return fallback;
}

/**
 * 下载远程产物到本地 artifacts（失败返回 null，不阻塞调用方）
 * @param {string} remoteUrl
 * @param {{fallbackExt?: string, timeoutMs?: number}} [opts]
 */
async function downloadArtifact(remoteUrl, { fallbackExt = '.png', timeoutMs = 120_000 } = {}) {
  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const name = `a${Date.now()}-${Math.random().toString(36).slice(2, 7)}${extFor(res.headers.get('content-type'), fallbackExt)}`;
    fs.writeFileSync(path.join(ARTIFACTS_DIR, name), buf);
    return { local_path: path.join(ARTIFACTS_DIR, name), local_url: `/artifacts/${name}` };
  } catch {
    return null;
  }
}

module.exports = { ARTIFACTS_DIR, downloadArtifact, extFor };
