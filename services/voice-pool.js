'use strict';
/**
 * services/voice-pool.js —— v1.9 TTS 音色备选池（settings.tts_voice_pool 的 JSON 读写）
 * 被设置读取、音色清单、备选池 CRUD、声音广场多处共用，独立成模块避免路由互依。
 */
const { settings } = require('../db');

/** 读取备选池（JSON 数组，坏数据容错为空数组） */
function getVoicePool() {
  try {
    const arr = JSON.parse(settings.get('tts_voice_pool') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 整池写回 */
function setVoicePool(pool) {
  settings.set('tts_voice_pool', JSON.stringify(pool));
}

module.exports = { getVoicePool, setVoicePool };
