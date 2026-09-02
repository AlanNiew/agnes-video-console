'use strict';
/**
 * routes/meta.js —— 元信息与健康检查（v1.9.1 拆分自 server.js）
 * /api/meta /api/health /api/openapi.json /api/logs
 */
const { DB_PATH } = require('../db');
const { buildOpenApi } = require('../core/openapi');
const { recent: recentLogs } = require('../core/logger');
const {
  MODELS,
  ASPECT_RATIOS,
  SECONDS_OK,
  IMAGE_MODEL,
  IMAGE_SIZES,
  IMAGE_RATIOS,
  LLM_MODEL,
} = require('../core/constants');

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
