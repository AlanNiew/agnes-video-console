'use strict';
/**
 * netmusic.js —— 音乐接口客户端（v1.4 BGM）
 * 对接自托管的音乐接口服务（网易云曲库）：
 *   GET /search?keyword=&limit=          搜索歌曲
 *   GET /player?id=&level=              获取播放地址（地址有时效性，使用前现取）
 * 认证：Authorization / X-Token 头（服务端保存，浏览器不可见）。
 * 配置：settings.music_api_base / music_api_token / music_level。
 * 说明：该接口仅限个人本地工具内搜索试听与为自制短片铺设背景音乐使用。
 */
const fs = require('node:fs');
const path = require('node:path');
const { settings, DEFAULT_SETTINGS } = require('./db');
const { ARTIFACTS_DIR } = require('./artifacts');
const { ApiError } = require('./errors');

const TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const LEVELS = ['standard', 'exhigh', 'lossless', 'hires'];

function baseUrl() {
  let u = String(settings.get('music_api_base', DEFAULT_SETTINGS.music_api_base) || '')
    .trim()
    .replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

function token() {
  return String(settings.get('music_api_token', DEFAULT_SETTINGS.music_api_token) || '').trim();
}

function headers(extra = {}) {
  const h = { ...extra };
  const t = token();
  if (t) h.Authorization = t;
  return h;
}

async function requestJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // fetch 网络层失败（连接被拒/DNS/超时/TLS）统一报 "fetch failed"，包装成可操作信息
    const host = String(url)
      .replace(/^https?:\/\//i, '')
      .split('?')[0]
      .split('/')[0];
    const hint =
      e.name === 'TimeoutError'
        ? `请求超时（${TIMEOUT_MS / 1000}s）`
        : `连接失败（${e.cause?.code || e.message || '未知网络错误'}）`;
    // 上游不可达：502 直接透传给前端，而不是笼统的 500
    throw new ApiError(
      502,
      `音乐接口服务不可达（${host}）：${hint}。请确认该服务已启动、设置中的 music_api_base 地址与端口正确`,
    );
  }
  const text = await res.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  if (!res.ok || !j || j.code !== 200) {
    throw new ApiError(502, `音乐接口错误（HTTP ${res.status}）：${String(j?.message || text || '').slice(0, 200)}`);
  }
  return j.data;
}

/** 搜索歌曲 → 规范化列表 */
async function search(keyword, limit = 8) {
  const base = baseUrl();
  if (!base) throw new ApiError(400, '尚未配置音乐接口地址（设置 → music_api_base）');
  const kw = String(keyword || '').trim();
  if (!kw) throw new ApiError(400, '请输入搜索关键词');
  const lim = Math.min(Math.max(Number(limit) || 8, 1), 50);
  const data = await requestJson(`${base}/search?keyword=${encodeURIComponent(kw)}&limit=${lim}`);
  const items = (Array.isArray(data) ? data : [])
    .map((s) => ({
      id: String(s.music_id ?? s.id ?? ''),
      name: String(s.music_name ?? s.name ?? '').trim(),
      artist: String(s.artist ?? '').trim(),
      album: String(s.album ?? '').trim(),
      duration_s: Number(s.duration) || 0, // 实测为秒（文档写毫秒，以实测为准）
      cover: String(s.pic_url ?? s.cover_url ?? '').trim(),
      levels: Array.isArray(s.levels) ? s.levels.map((l) => l.level) : [],
    }))
    .filter((s) => s.id && s.name);
  return items;
}

/** 获取播放地址（有时效性，使用前现取） */
async function playUrl(id, level) {
  const base = baseUrl();
  if (!base) throw new ApiError(400, '尚未配置音乐接口地址（设置 → music_api_base）');
  const lv = LEVELS.includes(String(level))
    ? String(level)
    : LEVELS.includes(String(settings.get('music_level', DEFAULT_SETTINGS.music_level)))
      ? String(settings.get('music_level', DEFAULT_SETTINGS.music_level))
      : 'exhigh';
  const data = await requestJson(`${base}/player?id=${encodeURIComponent(String(id))}&level=${lv}`);
  const url = String(data?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new ApiError(502, '音乐接口未返回有效播放地址（该歌曲可能无版权或需要 VIP）');
  return { url, level: lv };
}

/**
 * 下载 BGM 到本地缓存（artifacts/bgm-<id>-<level>.mp3；已存在直接复用）
 * @returns {{local_path: string, local_url: string, cached: boolean}}
 */
async function downloadBGM(id, level) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const lv = LEVELS.includes(String(level)) ? String(level) : 'exhigh';
  const name = `bgm-${String(id).replace(/[^\w-]/g, '')}-${lv}.mp3`;
  const localPath = path.join(ARTIFACTS_DIR, name);
  try {
    const st = fs.statSync(localPath);
    if (st.isFile() && st.size > 1024) {
      return { local_path: localPath, local_url: `/artifacts/${name}`, cached: true };
    }
  } catch {
    /* 不存在则下载 */
  }

  const { url } = await playUrl(id, lv);
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new ApiError(502, `BGM 下载失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new ApiError(502, 'BGM 下载数据异常（过小）');
  fs.writeFileSync(localPath, buf);
  return { local_path: localPath, local_url: `/artifacts/${name}`, cached: false };
}

module.exports = { search, playUrl, downloadBGM, LEVELS, baseUrl };
