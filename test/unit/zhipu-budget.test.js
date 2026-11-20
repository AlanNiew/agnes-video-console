'use strict';
// v2.7.3 智谱付费改投每日条数配额单测（纯函数；台账部分用临时 DATA_DIR 跑真实读写）
const { zhipuPaidQuotaAllows } = require('../../core/provider-policy');

describe('zhipuPaidQuotaAllows（自动改投每日条数：自动花钱必须有硬上限）', () => {
  test('配额内放行、用满即拦', () => {
    expect(zhipuPaidQuotaAllows({ cap: 20, usedToday: 0 }).allowed).toBe(true);
    expect(zhipuPaidQuotaAllows({ cap: 20, usedToday: 19 }).allowed).toBe(true);
    expect(zhipuPaidQuotaAllows({ cap: 20, usedToday: 20 }).allowed).toBe(false);
  });

  test('cap=0 → 不限（唯一合法的"不限"）', () => {
    expect(zhipuPaidQuotaAllows({ cap: 0, usedToday: 9999 }).allowed).toBe(true);
  });

  test('非法 cap（NaN/负数）→ 回落默认 20（不能当"不限"，那是危险方向）', () => {
    expect(zhipuPaidQuotaAllows({ cap: 'abc', usedToday: 0 }).cap).toBe(20);
    expect(zhipuPaidQuotaAllows({ cap: -5, usedToday: 0 }).cap).toBe(20);
    // 非法 cap 下依然受默认 20 约束：已用 20 后应被拦
    expect(zhipuPaidQuotaAllows({ cap: 'abc', usedToday: 20 }).allowed).toBe(false);
    // 显式 0 才是"不限"
    expect(zhipuPaidQuotaAllows({ cap: 0, usedToday: 20 }).allowed).toBe(true);
  });

  test('usedToday 非法值按 0 处理（脏台账不误伤配额判断）', () => {
    expect(zhipuPaidQuotaAllows({ cap: 20, usedToday: 'x' })).toEqual({ allowed: true, usedToday: 0, cap: 20 });
  });
});

describe('zhipu-budget 台账（跨天清零 / 与即梦积分台账相互独立）', () => {
  const budget = require('../../services/zhipu-budget');
  const { settings } = require('../../db');

  beforeEach(() => {
    settings.set('zhipu_paid_ledger', '{}');
    settings.set('zhipu_paid_daily_cap', '20');
    settings.set('dreamina_spend_ledger', '{}');
  });

  test('recordPaidShot 计数，且不动即梦积分台账', () => {
    budget.recordPaidShot();
    budget.recordPaidShot();
    expect(budget.paidShotsToday()).toBe(2);
    expect(require('../../services/dreamina-budget').spentToday()).toBe(0); // 两本账分开
    const q = budget.checkPaidQuota();
    expect(q.allowed).toBe(true); // 2/20 未满
  });

  test('配额用尽后闸门拦截，文案含条数与估算费用', () => {
    settings.set('zhipu_paid_daily_cap', '2');
    budget.recordPaidShot();
    budget.recordPaidShot();
    const q = budget.checkPaidQuota();
    expect(q.allowed).toBe(false);
    expect(q.text).toContain('2/2');
    expect(q.text).toContain('1 元');
  });

  test('todayPaidSummary 暴露已用/上限/估算费用', () => {
    budget.recordPaidShot();
    budget.recordPaidShot();
    expect(budget.todayPaidSummary()).toMatchObject({
      zhipu_paid_used: 2,
      zhipu_paid_cap: 20,
      zhipu_paid_remain: 18,
      zhipu_paid_cost_yuan: 1,
    });
  });

  test('台账按日期键存储，跨天不串账', () => {
    budget.recordPaidShot();
    const yesterday = new Date(Date.now() - 86400000);
    const ledger = budget.readPaidLedger();
    expect(ledger[budget.todayKey(yesterday)]).toBeUndefined();
    expect(ledger[budget.todayKey()]).toBe(1);
  });

  test('脏台账不抛错（视为空）', () => {
    settings.set('zhipu_paid_ledger', 'not-json{');
    expect(budget.paidShotsToday()).toBe(0);
    expect(budget.checkPaidQuota().allowed).toBe(true);
  });

  test('人工校正：setPaidForDay 可覆盖当日', () => {
    budget.recordPaidShot();
    budget.setPaidForDay(budget.todayKey(), 0);
    expect(budget.paidShotsToday()).toBe(0);
    budget.setPaidForDay(budget.todayKey(), 5);
    expect(budget.paidShotsToday()).toBe(5);
  });

  test('设 0 → 不限，闸门恒放行', () => {
    settings.set('zhipu_paid_daily_cap', '0');
    for (let i = 0; i < 25; i++) budget.recordPaidShot();
    expect(budget.checkPaidQuota().allowed).toBe(true);
    expect(budget.todayPaidSummary().zhipu_paid_remain).toBeNull();
  });

  test('非法上限值（写入坏配置）→ 服务层回落默认 20', () => {
    settings.set('zhipu_paid_daily_cap', 'abc');
    expect(budget.paidCap()).toBe(20);
    for (let i = 0; i < 20; i++) budget.recordPaidShot();
    expect(budget.checkPaidQuota().allowed).toBe(false);
  });
});
