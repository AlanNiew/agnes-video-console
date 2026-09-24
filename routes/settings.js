'use strict';
/**
 * routes/settings.js —— 设置读写（v1.9.1 拆分自 server.js）
 * GET/PUT /api/settings —— 敏感 Key 只回掩码；poll_interval_ms 变更即时重启轮询器
 */
const { settings, DEFAULT_SETTINGS } = require('../db');
const agnes = require('../clients/agnes');
const { LEVELS } = require('../clients/netmusic');
const manager = require('../workers/manager');
const { log } = require('../core/logger');
const { MODELS } = require('../core/constants');
const { ApiError } = require('../core/errors');
const dreaminaBudget = require('../services/dreamina-budget');
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
      // 服务进程是否带 Fish 代理（CONNECT 隧道）。缺失时 TTS 会整体 502——
      // 此前只能靠逐条配音失败才发现（E03 实测），故暴露给预检脚本判断。
      fish_proxy_set: Boolean(process.env.FISH_PROXY),
      fish_voice: settings.get('fish_voice', DEFAULT_SETTINGS.fish_voice),
      fish_speed: Number(settings.get('fish_speed', DEFAULT_SETTINGS.fish_speed)),
      // BGM（v1.4 音乐接口）
      music_api_base: settings.get('music_api_base', DEFAULT_SETTINGS.music_api_base),
      music_api_token_set: Boolean(settings.get('music_api_token', '')),
      music_level: settings.get('music_level', DEFAULT_SETTINGS.music_level),
      // v1.9 声音广场
      fish_web_token_set: Boolean(settings.get('fish_web_token', '')),
      voice_pool_count: getVoicePool().length,
      // v2.3 视频完成后自动下载本地开关（默认关：省磁盘，仅保留平台链接）
      video_auto_download: settings.get('video_auto_download', DEFAULT_SETTINGS.video_auto_download) === '1',
      // 即梦成本护栏：预估积分 > 阈值时前端需弹窗确认（默认 10；0 = 每次即梦调用都确认）
      dreamina_confirm_threshold: Number(
        settings.get('dreamina_confirm_threshold', DEFAULT_SETTINGS.dreamina_confirm_threshold),
      ),
      // 全自动成片的角色图是否用即梦主力档（关闭则用 Agnes 免费档）
      dreamina_auto_character:
        settings.get('dreamina_auto_character', DEFAULT_SETTINGS.dreamina_auto_character) === '1',
      // v2.6.1 即梦不可用/失败时是否自动改投免费档（默认开）
      dreamina_fallback: settings.get('dreamina_fallback', DEFAULT_SETTINGS.dreamina_fallback) === '1',
      // v2.6.7 反向回退：Agnes 排队失败时是否自动改投即梦（默认关，会消耗会员积分）
      dreamina_agnes_fallback:
        settings.get('dreamina_agnes_fallback', DEFAULT_SETTINGS.dreamina_agnes_fallback) === '1',
      // v2.6.9 反向回退里参考图的传法：first-frame（实测能出片）/ multimodal（全能参考）
      dreamina_ref_strategy: settings.get('dreamina_ref_strategy', DEFAULT_SETTINGS.dreamina_ref_strategy),
      // v2.6.10 即梦每日积分预算（硬约束，默认 100/天）
      dreamina_daily_budget: Number(settings.get('dreamina_daily_budget', DEFAULT_SETTINGS.dreamina_daily_budget)),
      // v2.6.11 自动兜底每日镜数上限（用户口径「只在必要镜头用即梦」）
      dreamina_daily_auto_shots: Number(
        settings.get('dreamina_daily_auto_shots', DEFAULT_SETTINGS.dreamina_daily_auto_shots),
      ),
      // v2.6.16 图片生成主力档（默认即梦 4.7；Agnes 为免费兜底）
      image_model: settings.get('image_model', DEFAULT_SETTINGS.image_model),
      ...dreaminaBudget.todaySummary(),
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
      if (!Number.isFinite(ms) || ms < 500 || ms > 30000)
        throw new ApiError(400, 'poll_interval_ms 需在 500–30000ms 之间');
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
      if (!Number.isInteger(ms) || ms < 0 || ms > 300000)
        throw new ApiError(400, 'submit_interval_ms 需为 0–300000 的整数（0 = 连续提交）');
      settings.set('submit_interval_ms', String(ms));
      changed.push('submit_interval_ms');
    }
    // TTS 设置（Fish Audio）
    if (b.fish_api_key !== undefined) {
      const k = String(b.fish_api_key).trim();
      if (k) {
        settings.set('fish_api_key', k);
        changed.push('fish_api_key');
      } else if (b.fish_api_key === '') {
        settings.set('fish_api_key', '');
        changed.push('fish_api_key');
      }
    }
    if (b.clear_fish_api_key === true) {
      settings.set('fish_api_key', '');
      changed.push('fish_api_key');
    }
    if (b.fish_voice !== undefined) {
      const v = String(b.fish_voice).trim().slice(0, 100);
      if (v) {
        settings.set('fish_voice', v);
        changed.push('fish_voice');
      }
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
      if (t) {
        settings.set('music_api_token', t);
        changed.push('music_api_token');
      } else if (b.music_api_token === '') {
        settings.set('music_api_token', '');
        changed.push('music_api_token');
      }
    }
    if (b.clear_music_api_token === true) {
      settings.set('music_api_token', '');
      changed.push('music_api_token');
    }
    if (b.music_level !== undefined) {
      const lv = String(b.music_level).trim();
      if (!LEVELS.includes(lv)) throw new ApiError(400, `music_level 仅支持 ${LEVELS.join('/')}`);
      settings.set('music_level', lv);
      changed.push('music_level');
    }
    // v1.9 声音广场 Token
    if (b.fish_web_token !== undefined) {
      const t = String(b.fish_web_token).trim();
      if (t) {
        settings.set('fish_web_token', t);
        changed.push('fish_web_token');
      } else if (b.fish_web_token === '') {
        settings.set('fish_web_token', '');
        changed.push('fish_web_token');
      }
    }
    if (b.clear_fish_web_token === true) {
      settings.set('fish_web_token', '');
      changed.push('fish_web_token');
    }
    // v2.3 视频自动下载开关（立即生效，无需重启）
    if (b.video_auto_download !== undefined) {
      settings.set('video_auto_download', b.video_auto_download ? '1' : '0');
      changed.push('video_auto_download');
    }
    // 即梦成本护栏阈值（积分）：0 = 每次即梦调用都需确认；极大值 = 从不确认
    if (b.dreamina_confirm_threshold !== undefined) {
      const n = Number(b.dreamina_confirm_threshold);
      if (!Number.isFinite(n) || n < 0 || n > 100000) {
        throw new ApiError(400, 'dreamina_confirm_threshold 须为 0–100000 的数值');
      }
      settings.set('dreamina_confirm_threshold', String(Math.round(n)));
      changed.push('dreamina_confirm_threshold');
    }
    // 全自动成片的角色图是否用即梦主力档（立即生效：auto 每轮 tick 重新读取）
    if (b.dreamina_auto_character !== undefined) {
      settings.set('dreamina_auto_character', b.dreamina_auto_character ? '1' : '0');
      changed.push('dreamina_auto_character');
    }
    if (b.dreamina_fallback !== undefined) {
      settings.set('dreamina_fallback', b.dreamina_fallback ? '1' : '0');
      changed.push('dreamina_fallback');
    }
    // v2.6.7 反向回退开关（Agnes 排队失败 → 改投即梦；消耗会员积分，默认关）
    if (b.dreamina_agnes_fallback !== undefined) {
      settings.set('dreamina_agnes_fallback', b.dreamina_agnes_fallback ? '1' : '0');
      changed.push('dreamina_agnes_fallback');
    }
    // v2.6.9 参考图传法：first-frame（默认，实测能出片）/ multimodal（全能参考）
    if (b.dreamina_ref_strategy !== undefined) {
      const v = String(b.dreamina_ref_strategy);
      if (v !== 'first-frame' && v !== 'multimodal') {
        throw new ApiError(400, "dreamina_ref_strategy 仅支持 'first-frame' 或 'multimodal'");
      }
      settings.set('dreamina_ref_strategy', v);
      changed.push('dreamina_ref_strategy');
    }
    // v2.6.11 自动兜底每日镜数上限（0=不限）
    if (b.dreamina_daily_auto_shots !== undefined) {
      const n = Number(b.dreamina_daily_auto_shots);
      if (!Number.isFinite(n) || n < 0 || n > 1000)
        throw new ApiError(400, 'dreamina_daily_auto_shots 须为 0–1000 的整数（0=不限）');
      settings.set('dreamina_daily_auto_shots', String(Math.round(n)));
      changed.push('dreamina_daily_auto_shots');
    }
    // v2.6.10 每日积分预算（0=不限）
    if (b.dreamina_daily_budget !== undefined) {
      const n = Number(b.dreamina_daily_budget);
      if (!Number.isFinite(n) || n < 0 || n > 100000)
        throw new ApiError(400, 'dreamina_daily_budget 须为 0–100000 的数值（0=不限）');
      settings.set('dreamina_daily_budget', String(Math.round(n)));
      changed.push('dreamina_daily_budget');
    }
    // 人工校正当日已花（失败任务/手工试跑的记账修正）
    if (b.dreamina_spent_today !== undefined) {
      dreaminaBudget.setSpentForDay(dreaminaBudget.todayKey(), Number(b.dreamina_spent_today));
      changed.push('dreamina_spend_ledger');
    }
    // v2.6.16 图片生成主力档（默认即梦；可切回 Agnes 免费档）
    if (b.image_model !== undefined) {
      const v = String(b.image_model || '').trim();
      const { DREAMINA_IMAGE_MODELS, IMAGE_MODEL } = require('../core/constants');
      if (v !== IMAGE_MODEL && !DREAMINA_IMAGE_MODELS[v]) {
        throw new ApiError(400, `image_model 仅支持 Agnes 图片档（${IMAGE_MODEL}）或即梦图片档（如 jimeng-image-4.7）`);
      }
      settings.set('image_model', v);
      changed.push('image_model');
    }
    if (b.clear_api_key === true) settings.set('api_key', '');
    manager.syncPoller(changed);
    log('info', `设置已更新: ${changed.join(', ') || '无'}`);
    res.json({ ok: true, changed });
  });
};
