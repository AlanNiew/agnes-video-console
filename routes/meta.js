'use strict';
/**
 * routes/meta.js —— 元信息与健康检查（v1.9.1 拆分自 server.js）
 * /api/meta /api/health /api/openapi.json /api/logs
 */
const { DB_PATH, settings, DEFAULT_SETTINGS } = require('../db');
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
  ZHIPU_MODELS,
  ZHIPU_DEFAULT_MODEL,
  ZHIPU_DEFAULT_BASE_URL,
  ZHIPU_PROMPT_MAX,
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
      // v2.6.16：image.model 是 **Agnes 免费兜底档**（前端"Agnes 图片"选项用），
      // image.default_model 才是**图片主力档**（默认即梦；前端即梦分组已按清单首位选中）
      image: {
        model: IMAGE_MODEL,
        default_model: String(settings.get('image_model', DEFAULT_SETTINGS.image_model) || ''),
        sizes: IMAGE_SIZES,
        ratios: IMAGE_RATIOS,
      },
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
          vip_only: Boolean(m.vipOnly),
          // 按子命令下发规格（各子命令的支持集与时长/分辨率/画幅规则不同）：
          // 前端据此过滤可选模型并联动 seconds/size —— 例如有首帧图时按 image2video 取规格
          specs: Object.fromEntries(
            Object.entries(m.specs || {}).map(([cmd, s]) => [
              cmd,
              {
                resolutions: s.resolutions,
                min_duration: s.minDuration,
                max_duration: s.maxDuration,
                omit_ratio: Boolean(s.omitRatio),
              },
            ]),
          ),
        })),
        image: Object.entries(DREAMINA_IMAGE_MODELS).map(([id, m]) => ({
          id,
          label: m.label,
          resolutions: m.resolutions,
        })),
      },
      // 智谱 CogVideoX（v2.7 视频替代主力）——同样**不混入上面的 models**，理由同即梦：
      // meta.models 是 Agnes 的公开契约（e2e 断言 + 前端 Agnes 分组），混入会让「默认模型」
      // 与「历史任务展示」都变味。前端按 provider 分组渲染，数据全部来自这里。
      //
      // 为什么要有这一块：Agnes 免费档（agnes-video-2.5-flash）自 2026-10 起每次提交都返回
      // 503 video_queue_full、免费 v2.0 又已于 2026-09-25 下线，视频主力必须切到智谱长期
      // 免费的 CogVideoX-Flash。前端要能选它、要能显示「没配 Key」的状态，都依赖本字段。
      zhipu: {
        enabled: settings.get('zhipu_enabled', '1') === '1',
        // has_key 只回布尔（真实 Key 永不离开服务端；设置弹窗只拿掩码）
        has_key: Boolean(settings.get('zhipu_api_key', '')),
        base_url: settings.get('zhipu_base_url', ZHIPU_DEFAULT_BASE_URL),
        model: settings.get('zhipu_model', ZHIPU_DEFAULT_MODEL),
        watermark: settings.get('zhipu_watermark', '1') === '1',
        quality: settings.get('zhipu_quality', 'speed'),
        // 超时阈值与 Agnes 的 20 分钟**分开**：免费档排队可能更久，且不能连带放宽 Agnes 的判死时间
        max_active_minutes: Number(
          settings.get('zhipu_max_active_minutes', DEFAULT_SETTINGS.zhipu_max_active_minutes ?? 30),
        ),
        // prompt 上限（512 字符）由服务端下发而非前端写死：上游改限制时只改 constants 一处
        prompt_max: ZHIPU_PROMPT_MAX,
        models: Object.entries(ZHIPU_MODELS).map(([id, m]) => ({
          id,
          label: m.label,
          short: m.short,
          free: Boolean(m.free),
          hint: m.hint,
          // sizes 是「规格」下拉的取值（如 1280x720），durations 是时长白名单（只有 5/10）
          sizes: m.sizes,
          durations: m.durations,
          rate_limit: m.rate_limit,
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
