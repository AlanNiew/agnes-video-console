'use strict';
/**
 * routes/meta.js —— 元信息与健康检查（v1.9.1 拆分自 server.js）
 * /api/meta /api/health /api/openapi.json /api/logs
 */
const { DB_PATH, settings } = require('../db');
const { buildOpenApi } = require('../core/openapi');
const { recent: recentLogs } = require('../core/logger');
const dreaminaClient = require('../clients/dreamina');
const {
  MODELS,
  DREAMINA_MODELS,
  DREAMINA_IMAGE_MODELS,
  DREAMINA_DEFAULT_THRESHOLD,
  ASPECT_RATIOS,
  SECONDS_OK,
  IMAGE_MODEL,
  IMAGE_SIZES,
  IMAGE_RATIOS,
  LLM_MODEL,
} = require('../core/constants');

/** 即梦 CLI 安装探测（纯文件检查、不 spawn；异常一律保守返回 false） */
function safeInstalled() {
  try {
    return dreaminaClient.isInstalled();
  } catch {
    return false;
  }
}

module.exports = function registerMetaRoutes(app) {
  // 前端元数据：模型/画幅/时长的单一事实来源，下拉与提示文案全部由此渲染
  app.get('/api/meta', (req, res) => {
    res.json({
      models: Object.entries(MODELS).map(([id, m]) => ({
        id,
        label: m.label,
        short: m.short,
        hint: m.hint,
        free: Boolean(m.free),
        deprecated: Boolean(m.deprecated),
        sizes: m.sizes || [],
        video_ref: id !== 'agnes-video-2.5-flash' && m.family === 'v25',
        max_images: id === 'agnes-video-2.5-flash' ? 5 : null,
        rate_limit: m.rate_limit || null, // v1.3：上游限流提示（前端展示与服务端节流同源）
      })),
      aspect_ratios: ASPECT_RATIOS,
      seconds: SECONDS_OK,
      image: { model: IMAGE_MODEL, sizes: IMAGE_SIZES, ratios: IMAGE_RATIOS },
      llm_model: LLM_MODEL,
      // 即梦（可选上游）——**刻意不混入上面的 models**，前端按 provider 分组渲染。
      // installed 用纯文件探测（不 spawn），保证本端点仍是高频廉价调用；
      // 登录态与剩余积分走 GET /api/dreamina/status，成本预估走 GET /api/dreamina/cost。
      dreamina: {
        installed: safeInstalled(),
        threshold: Number(settings.get('dreamina_confirm_threshold', DREAMINA_DEFAULT_THRESHOLD)),
        video: Object.entries(DREAMINA_MODELS).map(([id, m]) => ({
          id,
          label: m.label,
          resolutions: m.resolutions,
          min_duration: m.minDuration,
          max_duration: m.maxDuration,
          vip_only: Boolean(m.vipOnly),
        })),
        image: Object.entries(DREAMINA_IMAGE_MODELS).map(([id, m]) => ({
          id,
          label: m.label,
          resolutions: m.resolutions,
        })),
      },
    });
  });

  // 健康检查
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      app: 'agnes-video-console',
      uptime_s: Math.round(process.uptime()),
      db: DB_PATH,
      node: process.version,
    });
  });

  // API 自描述（v1.3）：机器可读的端点文档，自动化脚本 / Agent 无需读源码即可对接
  app.get('/api/openapi.json', (req, res) => {
    res.json(buildOpenApi(`${req.protocol}://${req.get('host') || '127.0.0.1:8273'}`));
  });

  // 日志（内存环形缓冲）
  app.get('/api/logs', (req, res) => res.json({ items: recentLogs(200) }));
};
