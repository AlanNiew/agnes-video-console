'use strict';
/**
 * routes/dreamina.js —— 即梦 CLI 管理路由（docs/DREAMINA_CLI_PLAN.md 阶段 1）
 *
 * 提供 5 个端点：
 *   GET  /api/dreamina/status      安装 / 登录 / 积分 / VIP 等级（带 60s 缓存）
 *   POST /api/dreamina/login       发起无头登录，返回授权材料（OAuth Device Flow）
 *   POST /api/dreamina/login/check 携 device_code 完成登录
 *   POST /api/dreamina/logout      清除本地登录态
 *   GET  /api/dreamina/cost        成本预估 + 护栏判定（供前端提交前调用）
 *
 * 设计纪律：
 *  1. **graceful 优先**：未安装 / 未登录必须返回结构化状态，绝不 500。
 *     CI 与 e2e 环境通常没有 CLI，端点必须可测（见计划文档 1.4 验收）。
 *  2. **必须缓存**：`credit()` 要 spawn CLI（实测约 1s），前端轮询会打爆，
 *     故进程内缓存 60s；失败时返回上次缓存并标 stale。
 */

const { settings, DEFAULT_SETTINGS } = require('../db');
const dreamina = require('../clients/dreamina');
const { log } = require('../core/logger');
const { ah } = require('../core/errors');
const { checkDreaminaGuard } = require('../services/payloads');

const CREDIT_CACHE_MS = 60_000;

/** 账户状态缓存（进程级；多实例各自缓存，可接受） */
let creditCache = { at: 0, data: null };

/**
 * 读取即梦账户状态（带缓存与降级）
 * @param {{refresh?: boolean}} [opts]
 */
async function readStatus(opts = {}) {
  const now = Date.now();
  const cached = creditCache.data;

  if (!opts.refresh && cached && now - creditCache.at < CREDIT_CACHE_MS) {
    return { ...cached, cached: true };
  }

  const bin = dreamina.resolveBin();
  let r;
  try {
    r = await dreamina.credit();
  } catch (e) {
    r = { ok: false, kind: 'spawn-error', error: e.message };
  }

  if (r?.ok && r.data) {
    const data = {
      installed: true,
      bin,
      logged_in: true,
      user_id: r.data.user_id ?? null,
      vip_level: r.data.vip_level ?? null,
      total_credit: Number.isFinite(Number(r.data.total_credit)) ? Number(r.data.total_credit) : null,
      cached_at: now,
      stale: false,
      reason: null,
      message: null,
    };
    creditCache = { at: now, data };
    return { ...data, cached: false };
  }

  // 未安装 / 未登录 / 调用异常：返回结构化状态（绝不抛错）。
  // 若曾有缓存，则回退到缓存值并标 stale，避免界面因一次抖动而清空。
  const kind = r?.kind || 'unknown';
  const base = {
    installed: kind !== 'not-installed',
    bin,
    logged_in: false,
    user_id: null,
    vip_level: null,
    total_credit: null,
    cached_at: now,
    reason: kind,
    message: r?.error || null,
  };
  if (cached && cached.logged_in) {
    return { ...cached, cached: true, stale: true, reason: kind, message: r?.error || null };
  }
  return { ...base, stale: false, cached: false };
}

module.exports = function registerDreaminaRoutes(app) {
  /* ---------------- 状态 ---------------- */
  app.get(
    '/api/dreamina/status',
    ah(async (req, res) => {
      res.json(await readStatus({ refresh: req.query.refresh === '1' }));
    }),
  );

  /* ---------------- 登录（OAuth Device Flow，无头） ---------------- */
  app.post(
    '/api/dreamina/login',
    ah(async (req, res) => {
      const r = await dreamina.loginHeadless();
      if (!r.ok) {
        // 已登录时 CLI 通常直接返回复用信息；拿不到 device_code 即视为需前端提示
        res.json({
          ok: false,
          reason: r.kind || 'login-failed',
          message: r.error || '未能获取授权材料（可能已登录或 CLI 异常）',
        });
        return;
      }
      log('info', '即梦登录已发起（等待用户在浏览器完成授权）');
      res.json({ ok: true, ...r.data });
    }),
  );

  app.post(
    '/api/dreamina/login/check',
    ah(async (req, res) => {
      const deviceCode = String((req.body || {}).device_code || '').trim();
      if (!deviceCode) {
        res.json({ ok: false, reason: 'bad-args', message: '缺少 device_code' });
        return;
      }
      const poll = Number((req.body || {}).poll);
      const r = await dreamina.checkLogin({ deviceCode, poll: Number.isFinite(poll) ? poll : 30 });
      if (!r.ok) {
        log('warn', `即梦登录未完成：${r.error || r.kind}`);
        res.json({ ok: false, reason: r.kind || 'login-failed', message: r.error || '授权未完成' });
        return;
      }
      creditCache = { at: 0, data: null }; // 登录态变化 → 失效缓存
      log('info', `即梦登录成功（user_id=${r.data?.user_id ?? '?'}，积分 ${r.data?.total_credit ?? '?'}）`);
      res.json({ ok: true, ...r.data });
    }),
  );

  app.post(
    '/api/dreamina/logout',
    ah(async (req, res) => {
      const r = await dreamina.logout();
      creditCache = { at: 0, data: null };
      log('info', `即梦登录态已清除（ok=${r.ok}）`);
      res.json({ ok: Boolean(r.ok), message: r.ok ? null : r.error || '登出失败' });
    }),
  );

  /* ---------------- 成本预估 + 护栏 ---------------- */
  app.get(
    '/api/dreamina/cost',
    ah(async (req, res) => {
      const q = req.query || {};
      const model = String(q.model || '').trim();
      const params = {
        duration: q.duration,
        seconds: q.seconds,
        video_resolution: q.video_resolution || q.size,
        size: q.size,
        resolution_type: q.resolution_type,
        count: q.count,
      };
      const threshold = Number(settings.get('dreamina_confirm_threshold', DEFAULT_SETTINGS.dreamina_confirm_threshold));

      // 剩余积分：优先用查询参数（前端已知），否则读状态缓存（不主动 spawn，
      // 避免每次成本预估都触发 CLI 调用）
      let remaining = Number.isFinite(Number(q.remaining)) ? Number(q.remaining) : null;
      if (remaining === null && creditCache.data?.logged_in) remaining = creditCache.data.total_credit;

      const guard = checkDreaminaGuard(model, params, { threshold, remainingCredit: remaining });
      if (!guard) {
        res.json({ ok: false, reason: 'not-dreamina', message: `非即梦模型：${model || '(空)'}` });
        return;
      }
      res.json({ ok: true, ...guard });
    }),
  );
};
