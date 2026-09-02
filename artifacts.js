'use strict';
/**
 * artifacts.js —— 本地产物归档（v1.3 从 server.js 抽出，供 server / poller 共用）
 * 图片/视频/音频等远程产物下载到 data/artifacts 做永久备份（平台远端链接会过期）。
 * v2.2：新增作品目录 data/works——渲染完成的成片/字幕/台词/海报按作品独立存放，
 * 与中间素材（artifacts）彻底分开，用户可直接翻目录找成品。
 */
const path = require('node:path');
const fs = require('node:fs');

const ARTIFACTS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'artifacts');
const WORKS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'works');

/**
 * 项目 → 作品目录名（sanitize 掉 Windows 非法字符）：`《项目名》-项目ID`
 * @returns {{dir: string, name: string}} dir=绝对路径 name=目录名
 */
function workDirFor(project) {
  const safe = String(project.name || '未命名')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 60);
  const name = `《${safe}》-${project.id}`;
  return { dir: path.join(WORKS_DIR, name), name };
}

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

module.exports = { ARTIFACTS_DIR, WORKS_DIR, workDirFor, downloadArtifact, extFor };
