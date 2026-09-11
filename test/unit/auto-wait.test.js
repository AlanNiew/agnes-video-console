'use strict';
/**
 * P1-2 全自动等待视频剩余时间预估单元测试 —— estimateWaitMinutes(pending, intervalMs)
 * 语义：提交受上游「1 次/分钟」限流约束，逐镜按提交间隔累加；未限流时按每镜最少 0.5 分钟兜底。
 */

const { estimateWaitMinutes } = require('../../workers/auto');

describe('estimateWaitMinutes（等待视频 ETA）', () => {
  test('无剩余镜头返回 0（不显示预估）', () => {
    expect(estimateWaitMinutes(0, 60000)).toBe(0);
    expect(estimateWaitMinutes(0, 0)).toBe(0);
  });

  test('默认限流 1 次/分钟：每镜约 1 分钟', () => {
    expect(estimateWaitMinutes(1, 60000)).toBe(1);
    expect(estimateWaitMinutes(8, 60000)).toBe(8);
    expect(estimateWaitMinutes(10, 120000)).toBe(20);
  });

  test('未限流（interval=0）时按每镜 0.5 分钟兜底，且至少 1 分钟', () => {
    expect(estimateWaitMinutes(3, 0)).toBe(2); // 3 × 0.5 = 1.5 → 2
    expect(estimateWaitMinutes(2, 30000)).toBe(1); // 2 × 0.5 = 1
    expect(estimateWaitMinutes(1, 0)).toBe(1);
  });

  test('非法/负数输入安全归零', () => {
    expect(estimateWaitMinutes(-5, 60000)).toBe(0);
    expect(estimateWaitMinutes(NaN, 60000)).toBe(0);
    expect(estimateWaitMinutes(undefined, 60000)).toBe(0);
    expect(estimateWaitMinutes(4, -1000)).toBe(2); // 负数间隔回落 0.5/镜兜底
  });

  test('随剩余镜数单调不减', () => {
    for (let n = 0; n < 12; n++) {
      expect(estimateWaitMinutes(n + 1, 60000)).toBeGreaterThanOrEqual(estimateWaitMinutes(n, 60000));
    }
  });
});
