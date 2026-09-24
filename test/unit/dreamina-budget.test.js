'use strict';
// v2.6.10 即梦每日积分预算闸门单测（纯函数；ledger 部分用临时 DATA_DIR 跑真实读写）
const { dreaminaBudgetAllows, budgetReasonText } = require('../../core/provider-policy');

describe('dreaminaBudgetAllows（每日 100 积分硬约束）', () => {
  test('未达上限 → 放行', () => {
    expect(dreaminaBudgetAllows({ cap: 100, spentToday: 0, estimate: 30 })).toEqual({
      allowed: true,
      reason: null,
      spentToday: 0,
      cap: 100,
    });
    expect(dreaminaBudgetAllows({ cap: 100, spentToday: 70, estimate: 30 }).allowed).toBe(true);
  });

  test('恰好用满（spent+est == cap）→ 放行（不超即可）', () => {
    expect(dreaminaBudgetAllows({ cap: 100, spentToday: 70, estimate: 30 }).allowed).toBe(true);
  });

  test('超 1 分即拦（100/天是硬上限）', () => {
    const r = dreaminaBudgetAllows({ cap: 100, spentToday: 71, estimate: 30 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('daily-budget-exhausted');
  });

  test('额度已用尽 → 任何估算都拦', () => {
    expect(dreaminaBudgetAllows({ cap: 100, spentToday: 100, estimate: 1 }).allowed).toBe(false);
  });

  test('cap=0 → 不限', () => {
    expect(dreaminaBudgetAllows({ cap: 0, spentToday: 99999, estimate: 30 }).allowed).toBe(true);
  });

  test('估算未知 → **保守拦截**（预算是硬约束，宁可少一次自动兜底）', () => {
    const r = dreaminaBudgetAllows({ cap: 100, spentToday: 0, estimate: null });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('unknown-estimate');
    const r2 = dreaminaBudgetAllows({ cap: 0, spentToday: 0, estimate: null });
    expect(r2.allowed).toBe(true);
  });

  test('坏输入回落到默认上限 100（**不能**当"不限"——否则一条坏配置就放开硬约束）', () => {
    expect(dreaminaBudgetAllows({ cap: 'abc', spentToday: 0, estimate: 30 }).cap).toBe(100);
    expect(dreaminaBudgetAllows({ cap: -5, spentToday: 0, estimate: 30 }).cap).toBe(100);
    // 非法 cap 下依然受 100 约束：已花 100 后 30 分的提交应被拦
    expect(dreaminaBudgetAllows({ cap: 'abc', spentToday: 100, estimate: 30 }).allowed).toBe(false);
    // 显式 0 才是"不限"
    expect(dreaminaBudgetAllows({ cap: 0, spentToday: 100, estimate: 30 }).allowed).toBe(true);
  });

  test('文案可读', () => {
    expect(budgetReasonText('daily-budget-exhausted', { spentToday: 100, cap: 100, estimate: 30 })).toContain(
      '100/100',
    );
    expect(budgetReasonText('unknown-estimate')).toContain('无法预估');
  });
});

describe('dreaminaAutoQuotaAllows（v2.6.11 自动兜底每日镜数：只在必要镜头用即梦）', () => {
  const { dreaminaAutoQuotaAllows } = require('../../core/provider-policy');

  test('配额内放行、用满即拦', () => {
    expect(dreaminaAutoQuotaAllows({ cap: 2, usedToday: 0 }).allowed).toBe(true);
    expect(dreaminaAutoQuotaAllows({ cap: 2, usedToday: 1 }).allowed).toBe(true);
    expect(dreaminaAutoQuotaAllows({ cap: 2, usedToday: 2 }).allowed).toBe(false);
  });

  test('cap=0 → 不限自动兜底镜数', () => {
    expect(dreaminaAutoQuotaAllows({ cap: 0, usedToday: 99 }).allowed).toBe(true);
  });

  test('非法 cap（NaN/负数）→ 视为 0（不限），不像预算那样回落到默认值', () => {
    // 镜数配额是"自动化节制"而非"钱的安全阀"：坏值不该反过来卡死自动兜底
    expect(dreaminaAutoQuotaAllows({ cap: 'abc', usedToday: 5 }).allowed).toBe(true);
    expect(dreaminaAutoQuotaAllows({ cap: -1, usedToday: 5 }).allowed).toBe(true);
  });
});

describe('自动兜底镜数台账（跨天清零 / 与积分台账相互独立）', () => {
  const budget = require('../../services/dreamina-budget');
  const { settings } = require('../../db');

  beforeEach(() => {
    settings.set('dreamina_auto_shot_ledger', '{}');
    settings.set('dreamina_daily_auto_shots', '2');
    settings.set('dreamina_spend_ledger', '{}');
  });

  test('recordAutoShot 计数，且不动积分台账', () => {
    budget.recordAutoShot();
    budget.recordAutoShot();
    expect(budget.autoShotsToday()).toBe(2);
    expect(budget.spentToday()).toBe(0); // 镜数与积分分开记
    const q = budget.checkAutoShotQuota();
    expect(q.allowed).toBe(false);
    expect(q.text).toContain('2/2');
  });

  test('配额用尽后闸门拦截，且提示引导手动升级', () => {
    budget.recordAutoShot();
    budget.recordAutoShot();
    expect(budget.checkAutoShotQuota().allowed).toBe(false);
    expect(budget.checkAutoShotQuota().text).toContain('升级即梦');
  });

  test('todaySummary 暴露镜数概览', () => {
    budget.recordAutoShot();
    expect(budget.todaySummary()).toMatchObject({ auto_shots_used: 1, auto_shots_cap: 2, auto_shots_remain: 1 });
  });

  test('设 0 → 不限，闸门恒放行', () => {
    settings.set('dreamina_daily_auto_shots', '0');
    for (let i = 0; i < 5; i++) budget.recordAutoShot();
    expect(budget.checkAutoShotQuota().allowed).toBe(true);
  });
});

describe('dreamina-budget 台账（跨天自动清零 / 记账不重复）', () => {
  const budget = require('../../services/dreamina-budget');
  const { settings } = require('../../db');

  beforeEach(() => {
    settings.set('dreamina_spend_ledger', '{}');
    settings.set('dreamina_daily_budget', '100');
  });

  test('recordSpend 累加当日记账', () => {
    budget.recordSpend(30);
    budget.recordSpend(1);
    expect(budget.spentToday()).toBe(31);
    expect(budget.todaySummary()).toMatchObject({ spent: 31, cap: 100, remain: 69, enabled: true });
  });

  test('台账按日期键存储，跨天不串账', () => {
    budget.recordSpend(30);
    const yesterday = new Date(Date.now() - 86400000);
    const yKey = budget.todayKey(yesterday);
    const ledger = budget.readLedger();
    expect(ledger[yKey]).toBeUndefined();
    expect(ledger[budget.todayKey()]).toBe(30);
  });

  test('闸门随记账收紧：31+70=101 > 100 → 拦', () => {
    budget.recordSpend(31);
    const r = budget.checkBudget(70);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('daily-budget-exhausted');
  });

  test('脏台账不抛错（视为空）', () => {
    settings.set('dreamina_spend_ledger', 'not-json{');
    expect(budget.spentToday()).toBe(0);
  });

  test('人工校正：setSpentForDay 可覆盖当日', () => {
    budget.setSpentForDay(budget.todayKey(), 7);
    expect(budget.spentToday()).toBe(7);
    budget.setSpentForDay(budget.todayKey(), 0);
    expect(budget.spentToday()).toBe(0);
  });

  test('记录 0 分（估算未知）不污染台账', () => {
    budget.recordSpend(null);
    budget.recordSpend(0);
    expect(budget.spentToday()).toBe(0);
  });
});
