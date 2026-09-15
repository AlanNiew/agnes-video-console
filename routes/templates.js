'use strict';
/**
 * routes/templates.js —— 创作模板（P2-7）
 * 把「创意写法 + 风格 + 画幅/时长 + 成片预设配方」存成可复用模板，创建项目时一键套用。
 * 存储于 settings.creation_templates（JSON 数组）——与 tts_voice_pool 同款 KV 模式，无需新表。
 */
const { settings, DEFAULT_SETTINGS } = require('../db');
const { ApiError, ah } = require('../core/errors');
const { log } = require('../core/logger');
const { ASPECT_RATIOS, SECONDS_OK, MAX_TEXT_LEN } = require('../core/constants');

const KEY = 'creation_templates';
const MAX_TEMPLATES = 50;
const MAX_NAME = 40;

function readAll() {
  try {
    const arr = JSON.parse(settings.get(KEY, DEFAULT_SETTINGS[KEY]));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeAll(arr) {
  settings.set(KEY, JSON.stringify(arr));
}

module.exports = function registerTemplateRoutes(app) {
  // 模板列表
  app.get(
    '/api/templates',
    ah(async (req, res) => {
      res.json({ items: readAll() });
    }),
  );

  // 新建模板（保存当前创作参数）
  app.post(
    '/api/templates',
    ah(async (req, res) => {
      const b = req.body || {};
      const name = String(b.name || '')
        .trim()
        .slice(0, MAX_NAME);
      if (!name) throw new ApiError(400, '模板名称不能为空');
      const all = readAll();
      if (all.length >= MAX_TEMPLATES) throw new ApiError(400, `模板数量已达上限（${MAX_TEMPLATES}）`);
      const tpl = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        idea: String(b.idea || '').slice(0, MAX_TEXT_LEN),
        style: String(b.style || '').slice(0, 200),
        aspect_ratio: ASPECT_RATIOS.includes(String(b.aspect_ratio)) ? String(b.aspect_ratio) : '16:9',
        seconds: SECONDS_OK.includes(String(b.seconds)) ? String(b.seconds) : '5',
        film_preset: String(b.film_preset || '').slice(0, 40),
        // v2.5 系列模板扩展：角色库引用 + 声音偏好 + 命名规范（新建项目成套复用）
        character_ids: Array.isArray(b.character_ids) ? b.character_ids.map(String).slice(0, 8) : [],
        voice:
          String(b.voice || '')
            .trim()
            .slice(0, 80) || null, // 配音音色 id（TTS_VOICES / 声音广场池）
        bgm_song_id:
          String(b.bgm_song_id || '')
            .trim()
            .slice(0, 30) || null, // BGM 偏好（音乐接口 song_id）
        naming:
          String(b.naming || '')
            .trim()
            .slice(0, 60) || null, // 命名规范模板（如「幻灯屋 S1EXX」）
        created_at: Date.now(),
      };
      all.unshift(tpl);
      writeAll(all);
      log('info', `创作模板已保存：${name}`);
      res.status(201).json(tpl);
    }),
  );

  // 删除模板
  app.delete(
    '/api/templates/:id',
    ah(async (req, res) => {
      const all = readAll();
      const next = all.filter((t) => t.id !== req.params.id);
      if (next.length === all.length) throw new ApiError(404, '模板不存在');
      writeAll(next);
      res.json({ ok: true });
    }),
  );
};
