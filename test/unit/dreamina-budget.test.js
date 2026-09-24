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
