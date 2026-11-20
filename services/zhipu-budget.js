'use strict';
/**
 * services/zhipu-budget.js —— 智谱**付费改投的每日条数配额**记账与闸门（v2.7.3）
 *
 * 为什么需要：免费档限流（429/1305）实测可从晚上持续到次日早上（>11 小时），v2.7.2 的
 * 「自动改投 cogvideox-2（0.5 元/条）」若无配额，无人值守的 24h 创作会在每个高峰把
 * 整集镜头全部翻成付费——20 镜 ≈ 10 元/集，跨集无上限。这与用户「自动花钱必须有硬上限」
 * 的既有口径（即梦每日 100 积分预算）冲突，故完全镜像 services/dreamina-budget.js 的模式：
 *   - **不新增数据库表**：台账存 settings（`zhipu_paid_ledger` = `{ "YYYY-MM-DD": 条 }`），
 *     跨天自动视为 0，与其它设置项同一套 get/set；
 *   - **记账时机 = 改投即预扣**：改投后提交失败也可能已被智谱扣费，宁可高估已花（配额只会
 *     更早收紧，不会漏）；人工可在设置里按需校正（PUT zhipu_paid_today）。
 *   - 只拦**自动改投**：用户手动选 cogvideox-2/3 提交不占此配额（自己的决定自己负责）。
 */
const { settings, DEFAULT_SETTINGS } = require('../db');
const { ZHIPU_PAID_DAILY_CAP_DEFAULT, ZHIPU_PAID_FALLBACK_PRICE_YUAN } = require('../core/constants');
const { zhipuPaidQuotaAllows } = require('../core/provider-policy');

/** 今天的日期键（本地时区，与即梦预算同一口径：跨 0 点即新的一天） */
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读取台账（解析失败时视为空，绝不因脏数据抛错影响创作） */
function readPaidLedger() {
  try {
    const raw = JSON.parse(settings.get('zhipu_paid_ledger', '{}') || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** 当日已自动改投条数 */
function paidShotsToday(d = new Date()) {
  return Number(readPaidLedger()[todayKey(d)]) || 0;
}

/** 每日上限（0=不限；非法值回落默认 20，见 provider-policy.zhipuPaidQuotaAllows 的安全方向说明） */
function paidCap() {
  const raw = settings.get(
    'zhipu_paid_daily_cap',
    String(DEFAULT_SETTINGS.zhipu_paid_daily_cap ?? ZHIPU_PAID_DAILY_CAP_DEFAULT),
  );
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : ZHIPU_PAID_DAILY_CAP_DEFAULT;
}

/**
 * 自动改投闸门：本次改投是否还在今日条数配额内。
 * @returns {{allowed:boolean, usedToday:number, cap:number, text:string}}
 *          text 在拦截时给出可直接写进日志/任务备注的中文说明，放行时为空串。
 */
function checkPaidQuota() {
  const cap = paidCap();
  const used = paidShotsToday();
  const d = zhipuPaidQuotaAllows({ cap, usedToday: used });
  const text = d.allowed
    ? ''
    : `智谱付费改投今日已达上限（已 ${used}/${d.cap} 条 ≈ ${used * ZHIPU_PAID_FALLBACK_PRICE_YUAN} 元），继续等待免费档恢复`;
  return { ...d, text };
}

/**
 * 记一次自动改投（改投付费档时调用，预扣 1 条）。
 * @returns {number} 记账后的当日累计条数
 */
function recordPaidShot() {
  const key = todayKey();
  const ledger = readPaidLedger();
  // 只保留今天与最近 7 天，避免台账无限增长
  const pruned = {};
  for (const [k, v] of Object.entries(ledger)) {
    const d = new Date(`${k}T00:00:00`);
    if (Number.isFinite(d.getTime()) && (Date.now() - d.getTime()) / 86400000 <= 7) pruned[k] = v;
  }
  pruned[key] = (Number(pruned[key]) || 0) + 1;
  settings.set('zhipu_paid_ledger', JSON.stringify(pruned));
  return Number(pruned[key]);
}

/** 人工校正（设置面板/脚本用）：把某天的记账改为指定值 */
function setPaidForDay(dayKey, count) {
  const ledger = readPaidLedger();
  ledger[String(dayKey)] = Math.max(0, Math.round(Number(count) || 0));
  settings.set('zhipu_paid_ledger', JSON.stringify(ledger));
  return ledger[String(dayKey)];
}

/** 供 UI/诊断：今日概览（费用为估算，实际以智谱账单为准） */
function todayPaidSummary() {
  const cap = paidCap();
  const used = paidShotsToday();
  return {
    zhipu_paid_used: used,
    zhipu_paid_cap: cap,
    zhipu_paid_remain: cap > 0 ? Math.max(0, cap - used) : null,
    zhipu_paid_cost_yuan: Number((used * ZHIPU_PAID_FALLBACK_PRICE_YUAN).toFixed(2)),
  };
}

module.exports = {
  todayKey,
  readPaidLedger,
  paidShotsToday,
  paidCap,
  checkPaidQuota,
  recordPaidShot,
  setPaidForDay,
  todayPaidSummary,
};
