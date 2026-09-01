'use strict';
/**
 * submitter 退避逻辑单元测试 —— 指数退避数学（429 限流 / 网络异常）
 * 默认环境（未设 SUBMIT_RATE_LIMIT_BASE_MS）：
 *   429：基数 60s，上限 10min；网络异常：基数 10s，上限 60s；最多 5 次尝试。
 */

const { computeBackoffMs } = require('../../submitter');

describe('computeBackoffMs（429 限流退避）', () => {
  test('第 1–4 次重试按 60s 基数指数递增', () => {
    expect(computeBackoffMs(1, 'rate-limit')).toBe(60_000);
    expect(computeBackoffMs(2, 'rate-limit')).toBe(120_000);
    expect(computeBackoffMs(3, 'rate-limit')).toBe(240_000);
    expect(computeBackoffMs(4, 'rate-limit')).toBe(480_000);
  });

  test('第 5 次触顶 10 分钟上限（不再翻倍）', () => {
    expect(computeBackoffMs(5, 'rate-limit')).toBe(600_000);
    expect(computeBackoffMs(9, 'rate-limit')).toBe(600_000);
  });
});

describe('computeBackoffMs（网络异常退避）', () => {
  test('第 1–3 次按 10s 基数指数递增', () => {
    expect(computeBackoffMs(1, 'net')).toBe(10_000);
    expect(computeBackoffMs(2, 'net')).toBe(20_000);
    expect(computeBackoffMs(3, 'net')).toBe(40_000);
  });

  test('第 4 次触顶 60 秒上限', () => {
    expect(computeBackoffMs(4, 'net')).toBe(60_000);
    expect(computeBackoffMs(6, 'net')).toBe(60_000);
  });
});

describe('退避契约（防回归）', () => {
  test('attempts 从 1 起（首次失败即退避 1 个基数，不是 0）', () => {
    expect(computeBackoffMs(1, 'rate-limit')).toBeGreaterThan(0);
    expect(computeBackoffMs(1, 'net')).toBeGreaterThan(0);
  });

  test('退避序列单调不减', () => {
    for (let a = 1; a < 8; a++) {
      expect(computeBackoffMs(a + 1, 'rate-limit')).toBeGreaterThanOrEqual(computeBackoffMs(a, 'rate-limit'));
      expect(computeBackoffMs(a + 1, 'net')).toBeGreaterThanOrEqual(computeBackoffMs(a, 'net'));
    }
  });
});
