'use strict';
/**
 * routes/settings.js —— 设置读写（v1.9.1 拆分自 server.js）
 * GET/PUT /api/settings —— 敏感 Key 只回掩码；poll_interval_ms 变更即时重启轮询器
 */
const { settings, DEFAULT_SETTINGS } = require('../db');
const agnes = require('../agnes');
const netmusic = require('../netmusic');
const poller = require('../poller');
const { log } = require('../logger');
const { MODELS } = require('../constants');
const { ApiError } = require('../errors');
const { isHttpUrl } = require('../services/payloads');
const { getVoicePool } = require('../services/voice-pool');

module.exports = function registerSettingsRoutes(app) {
  // 获取设置（API Key 永远只返回掩码）
  app.get('/api/settings', (req, res) => {
    const key = settings.get('api_key', '');
    const fish = settings.get('fish_api_key', '');
    res.json({
      api_key_set: Boolean(key),
      api_key_masked: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : '',
      base_url: settings.get('base_url', DEFAULT_SETTINGS.base_url),
      model: settings.get('model', DEFAULT_SETTINGS.model),
      poll_interval_ms: Number(settings.get('poll_interval_ms', DEFAULT_SETTINGS.poll_interval_ms)),
      max_active_minutes: Number(settings.get('max_active_minutes', DEFAULT_SETTINGS.max_active_minutes)),
      submit_interval_ms: Number(settings.get('submit_interval_ms', DEFAULT_SETTINGS.submit_interval_ms)),
      // TTS（Fish Audio）
      fish_api_key_set: Boolean(fish),
      fish_api_key_masked: fish ? `${fish.slice(0, 6)}****${fish.slice(-4)}` : '',
      fish_voice: settings.get('fish_voice', DEFAULT_SETTINGS.fish_voice),
      fish_speed: Number(settings.get('fish_speed', DEFAULT_SETTINGS.fish_speed)),
      // BGM（v1.4 音乐接口）
      music_api_base: settings.get('music_api_base', DEFAULT_SETTINGS.music_api_base),
      music_api_token_set: Boolean(settings.get('music_api_token', '')),
      music_level: settings.get('music_level', DEFAULT_SETTINGS.music_level),
      // v1.9 声音广场
      fish_web_token_set: Boolean(settings.get('fish_web_token', '')),
      voice_pool_count: getVoicePool().length,
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
    if (b.submit_interval_ms !== undefined) {
      const ms = Number(b.submit_interval_ms);
      if (!Number.isInteger(ms) || ms < 0 || ms > 300000) throw new ApiError(400, 'submit_interval_ms 需为 0–300000 的整数（0 = 连续提交）');
      settings.set('submit_interval_ms', String(ms));
      changed.push('submit_interval_ms');
    }
    // TTS 设置（Fish Audio）
    if (b.fish_api_key !== undefined) {
      const k = String(b.fish_api_key).trim();
      if (k) { settings.set('fish_api_key', k); changed.push('fish_api_key'); }
      else if (b.fish_api_key === '') { settings.set('fish_api_key', ''); changed.push('fish_api_key'); }
    }
    if (b.clear_fish_api_key === true) { settings.set('fish_api_key', ''); changed.push('fish_api_key'); }
    if (b.fish_voice !== undefined) {
      const v = String(b.fish_voice).trim().slice(0, 100);
      if (v) { settings.set('fish_voice', v); changed.push('fish_voice'); }
    }
    if (b.fish_speed !== undefined) {
      const sp = Number(b.fish_speed);
      if (!Number.isFinite(sp) || sp < 0.5 || sp > 2) throw new ApiError(400, 'fish_speed 需在 0.5–2.0 之间');
      settings.set('fish_speed', String(sp));
      changed.push('fish_speed');
    }
    // BGM 音乐接口设置（v1.4）
    if (b.music_api_base !== undefined) {
      const u = String(b.music_api_base).trim().replace(/\/+$/, '');
      if (u && !isHttpUrl(u)) throw new ApiError(400, 'music_api_base 必须是 http(s) 地址');
      settings.set('music_api_base', u);
      changed.push('music_api_base');
    }
    if (b.music_api_token !== undefined) {
      const t = String(b.music_api_token).trim();
      if (t) { settings.set('music_api_token', t); changed.push('music_api_token'); }
      else if (b.music_api_token === '') { settings.set('music_api_token', ''); changed.push('music_api_token'); }
    }
    if (b.clear_music_api_token === true) { settings.set('music_api_token', ''); changed.push('music_api_token'); }
    if (b.music_level !== undefined) {
      const lv = String(b.music_level).trim();
      if (!netmusic.LEVELS.includes(lv)) throw new ApiError(400, `music_level 仅支持 ${netmusic.LEVELS.join('/')}`);
      settings.set('music_level', lv);
      changed.push('music_level');
    }
    // v1.9 声音广场 Token
    if (b.fish_web_token !== undefined) {
      const t = String(b.fish_web_token).trim();
      if (t) { settings.set('fish_web_token', t); changed.push('fish_web_token'); }
      else if (b.fish_web_token === '') { settings.set('fish_web_token', ''); changed.push('fish_web_token'); }
    }
    if (b.clear_fish_web_token === true) { settings.set('fish_web_token', ''); changed.push('fish_web_token'); }
    if (b.clear_api_key === true) settings.set('api_key', '');
    if (changed.includes('poll_interval_ms') || !poller.timer) poller.start();
    log('info', `设置已更新: ${changed.join(', ') || '无'}`);
    res.json({ ok: true, changed });
  });
};
