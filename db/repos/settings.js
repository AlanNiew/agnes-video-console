'use strict';
/**
 * db/repos/settings.js —— settings 表仓库（M3-P3）
 */
const stmts = require('../sql');

const settings = {
  get(key, fallback = null) {
    const r = stmts.getSetting.get(key);
    return r ? r.value : fallback;
  },
  set(key, value) {
    stmts.setSetting.run(key, String(value));
  },
};

/** 默认设置（与文档对齐） */
const { DEFAULT_BASE_URL } = require('../../core/config');

const DEFAULT_SETTINGS = {
  base_url: DEFAULT_BASE_URL,
  model: 'agnes-video-2.5-flash',
  poll_interval_ms: '2000',
  max_active_minutes: '20',
  submit_interval_ms: '60000', // M2：批量分镜提交间隔（0 = 连续提交）
  fish_api_key: '', // TTS：Fish Audio API Key（可选；不配置则配音功能不可用）
  fish_voice: 'default', // TTS：默认音色（default = 平台默认；或 Fish 音色库模型 id）
  fish_speed: '1', // TTS：默认语速 0.5–2.0
  music_api_base: '', // v1.4 BGM：音乐接口地址（如 http://60.204.147.98:15001；留空则 BGM 功能不可用）
  music_api_token: '', // v1.4 BGM：音乐接口 Token（Authorization 头，仅服务端使用）
  music_level: 'exhigh', // v1.4 BGM：默认音质 standard/exhigh/lossless/hires
  fish_web_token: '', // v1.9 声音广场：fish.audio 网页端 Token（浏览社区音色；仅服务端使用）
  tts_voice_pool: '[]', // v1.9 音色备选池（JSON 数组：从声音广场收录的真实音色）
};
module.exports = { settings, DEFAULT_SETTINGS };
