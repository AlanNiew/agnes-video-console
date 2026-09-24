'use strict';
/**
 * services/dreamina-budget.js —— 即梦**每日积分预算**记账与闸门（v2.6.10）
 *
 * 为什么需要：用户账号 standard 档，运营约束是**每天最多 100 积分**。而 `dreamina user_credit`
 * 只报**跨天总余额**，不提供"当日已用 / 日限额"字段 —— 余额充足不代表今天还能花。
 * 若无人值守时「自动角色图 + 反向回退兜底」一起跑，一天能烧掉几百积分，因此必须自己按日记账。
 *
 * 设计取舍：
 *   - **不新增数据库表**：台账存 settings（`dreamina_spend_ledger` = `{ "YYYY-MM-DD": 分 }`），
 *     跨天自动视为 0；这样无需 schema 变更，且与其它设置项同一套 get/set。
 *   - **记账时机 = 提交即梦前**（预扣）：即梦在提交成功时就扣费，若等到"完成"才记，
 *     并发/失败场景会漏记导致超支。失败任务由人工按需在设置里校正。
 *   - **预算是硬约束**：预估值未知（少数未标定规格）时**拦截**而非放行 —— 宁可少一次自动兜底。
 */
const { settings, DEFAULT_SETTINGS } = require('../db');
const { DREAMINA_DAILY_BUDGET_DEFAULT } = require('../core/constants');
const { dreaminaBudgetAllows, budgetReasonText } = require('../core/provider-policy');

/** 今天的日期键（本地时区，与运维口径一致：跨 0 点即新的一天） */
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读取台账（解析失败时视为空，绝不因脏数据抛错影响创作） */
function readLedger() {
  try {
    const raw = JSON.parse(settings.get('dreamina_spend_ledger', '{}') || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** 当日已提交记账（分） */
function spentToday(d = new Date()) {
  return Number(readLedger()[todayKey(d)]) || 0;
}

/** 预算上限（0=不限） */
function budgetCap() {
  const raw = settings.get(
    'dreamina_daily_budget',
    String(DEFAULT_SETTINGS.dreamina_daily_budget ?? DREAMINA_DAILY_BUDGET_DEFAULT),
  );
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DREAMINA_DAILY_BUDGET_DEFAULT;
}

/**
 * 提交前闸门：本次预计消耗 estimate 分是否还能花。
 * @param {number|null|undefined} estimate 分；null/undefined = 未知（保守拦截，除非不限额）
 * @returns {{allowed:boolean, reason:string|null, text:string, spentToday:number, cap:number, estimate:number|null}}
 */
function checkBudget(estimate) {
  const cap = budgetCap();
  const spent = spentToday();
  const d = dreaminaBudgetAllows({ cap, spentToday: spent, estimate });
  const pts = Number(estimate) || null;
  return { ...d, estimate: pts, text: budgetReasonText(d.reason, { spentToday: spent, cap, estimate: pts ?? '?' }) };
}

/**
 * 记账（提交即梦前调用，预扣本次 estimate 分）。
 * @returns {number} 记账后的当日累计
 */
function recordSpend(estimate) {
  const pts = Number(estimate);
  if (!Number.isFinite(pts) || pts <= 0) return spentToday();
  const key = todayKey();
  const ledger = readLedger();
  // 只保留今天与最近 7 天，避免台账无限增长
  const pruned = {};
  for (const [k, v] of Object.entries(ledger)) {
    const d = new Date(`${k}T00:00:00`);
    if (Number.isFinite(d.getTime()) && (Date.now() - d.getTime()) / 86400000 <= 7) pruned[k] = v;
  }
  pruned[key] = (Number(pruned[key]) || 0) + pts;
  settings.set('dreamina_spend_ledger', JSON.stringify(pruned));
  return Number(pruned[key]);
}

/** 人工校正（设置面板/脚本用）：把某天的记账改为指定值 */
function setSpentForDay(dayKey, points) {
  const ledger = readLedger();
  ledger[String(dayKey)] = Math.max(0, Number(points) || 0);
  settings.set('dreamina_spend_ledger', JSON.stringify(ledger));
  return ledger[String(dayKey)];
}

/** 供 UI/诊断：今日概览 */
function todaySummary() {
  const cap = budgetCap();
  const spent = spentToday();
  return { day: todayKey(), spent, cap, remain: cap > 0 ? Math.max(0, cap - spent) : null, enabled: cap > 0 };
}

module.exports = {
  todayKey,
  readLedger,
  spentToday,
  budgetCap,
  checkBudget,
  recordSpend,
  setSpentForDay,
  todaySummary,
};
