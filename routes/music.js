'use strict';
/**
 * routes/music.js —— BGM 音乐：搜索 / 试听流代理 / 项目选歌（v1.9.1 拆分自 server.js）
 */
const { Readable, pipeline: streamPipeline } = require('node:stream');
const { settings, DEFAULT_SETTINGS, projects } = require('../db');
const netmusic = require('../netmusic');
const { log } = require('../logger');
const { ApiError, ah } = require('../errors');

const MUSIC_LEVELS = netmusic.LEVELS;

module.exports = function registerMusicRoutes(app) {
  // 搜索歌曲（代理音乐接口，规范化字段）
  app.get('/api/music/search', ah(async (req, res) => {
    const keyword = String(req.query.keyword || '').trim().slice(0, 100);
    if (!keyword) throw new ApiError(400, '请输入搜索关键词 keyword');
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 50);
    const items = await netmusic.search(keyword, limit);
    res.json({ items, keyword, limit });
  }));

  // 试听流代理：现取播放地址并把音频流转发给浏览器（播放地址有时效性，不能落库直链）
  app.get('/api/music/stream', ah(async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!/^\d+$/.test(id)) throw new ApiError(400, 'id 需为纯数字歌曲 ID');
    const level = MUSIC_LEVELS.includes(String(req.query.level)) ? String(req.query.level) : undefined;
    const { url } = await netmusic.playUrl(id, level);
    const upstream = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!upstream.ok || !upstream.body) throw new ApiError(502, `试听流获取失败（HTTP ${upstream.status}）`);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    // 用 pipeline 转发：pipeline 会正确挂接/清理两端的 error 与 close 事件。
    // 若用裸 .pipe()，上游 body 因超时/断流 emit 'error' 时无人监听，
    // Node 会直接把该错误抛成 uncaughtException 导致整个进程崩溃。
    streamPipeline(Readable.fromWeb(upstream.body), res, (err) => {
      if (err && err.name !== 'AbortError') log('warn', `试听流中断: ${err.message}`);
    });
  }));

  // 项目选用 BGM：{song_id, name, artist?, album?, level?} → 立即下载缓存本地并落库
  app.post('/api/projects/:id/bgm', ah(async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const b = req.body || {};
    const songId = String(b.song_id || '').trim();
    if (!/^\d+$/.test(songId)) throw new ApiError(400, 'song_id 需为纯数字歌曲 ID');
    const level = MUSIC_LEVELS.includes(String(b.level)) ? String(b.level)
      : settings.get('music_level', DEFAULT_SETTINGS.music_level);
    const dl = await netmusic.downloadBGM(songId, level);
    const bgm = {
      song_id: songId,
      name: String(b.name || '').trim().slice(0, 200) || `歌曲 ${songId}`,
      artist: String(b.artist || '').trim().slice(0, 100) || '',
      album: String(b.album || '').trim().slice(0, 100) || '',
      level,
      local_path: dl.local_path,
      local_url: dl.local_url,
      cached: dl.cached,
      selected_at: Date.now(),
    };
    projects.setBgm(p.id, bgm);
    log('info', `项目 #${p.id} 选用 BGM：《${bgm.name}》- ${bgm.artist}（${level}${dl.cached ? '，缓存命中' : '，已下载'}）`);
    res.json({ ok: true, bgm });
  }));

  // 清除项目 BGM 选择（本地缓存文件保留，便于再次选用）
  app.delete('/api/projects/:id/bgm', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    projects.setBgm(p.id, null);
    log('info', `项目 #${p.id} 清除 BGM 选择`);
    res.json({ ok: true });
  });
};
