'use strict';
/**
 * submitter 退避逻辑单元测试 —— 指数退避数学（429 限流 / 网络异常）
 * 默认环境（未设 SUBMIT_RATE_LIMIT_BASE_MS）：
 *   429：基数 60s，上限 10min；网络异常：基数 10s，上限 60s；最多 5 次尝试。
 */

const {
  computeBackoffMs,
  planZhipuRetry,
  shouldZhipuPaidFallback,
  retargetZhipuPayload,
} = require('../../workers/submitter');

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

describe('planZhipuRetry（智谱免费档按等待预算重试）', () => {
  test('预算内继续重试，退避沿用 computeBackoffMs', () => {
    const p = planZhipuRetry({ attempts: 2, waitedMs: 5 * 60_000, waitLimitMs: 60 * 60_000, kind: 'rate-limit' });
    expect(p.giveUp).toBe(false);
    expect(p.delay).toBe(computeBackoffMs(2, 'rate-limit'));
    expect(p.waitedMin).toBe(5);
  });

  test('等待 + 下次退避会超预算时判死（不再固定 5 次上限）', () => {
    const limit = 60 * 60_000;
    const p = planZhipuRetry({ attempts: 7, waitedMs: limit - 30_000, waitLimitMs: limit, kind: 'rate-limit' });
    expect(p.giveUp).toBe(true);
  });

  test('第 12 次重试仍可能继续（免费档高峰期不限次数，只看时长）', () => {
    const p = planZhipuRetry({ attempts: 12, waitedMs: 20 * 60_000, waitLimitMs: 3 * 60 * 60_000, kind: 'rate-limit' });
    expect(p.giveUp).toBe(false);
    expect(p.delay).toBe(600_000); // 触顶 10 分钟
  });

  test('attempts 非法值按 1 处理；waitedMin 取整', () => {
    const p = planZhipuRetry({ attempts: 0, waitedMs: 90_000, waitLimitMs: 60 * 60_000, kind: 'net' });
    expect(p.delay).toBe(computeBackoffMs(1, 'net'));
    expect(p.waitedMin).toBe(2);
  });

  test('预算为 0/缺省时不主动判死', () => {
    expect(planZhipuRetry({ attempts: 3, waitedMs: 10 ** 9, waitLimitMs: 0, kind: 'rate-limit' }).giveUp).toBe(false);
    expect(planZhipuRetry({ attempts: 3, waitedMs: 10 ** 9, kind: 'rate-limit' }).giveUp).toBe(false);
  });
});

describe('shouldZhipuPaidFallback（免费档限流 → 自动改投付费性价比档）', () => {
  const base = { model: 'cogvideox-flash', kind: 'rate-limit', enabled: '1', attempts: 2 };

  test('免费档 + 容量限流 + 已试 2 次 → 改投', () => {
    expect(shouldZhipuPaidFallback(base)).toBe(true);
    expect(shouldZhipuPaidFallback({ ...base, kind: 'queue-full', attempts: 3 })).toBe(true);
  });

  test('只试 1 次不改投（避免瞬时抖动就花钱）', () => {
    expect(shouldZhipuPaidFallback({ ...base, attempts: 1 })).toBe(false);
    expect(shouldZhipuPaidFallback({ ...base, attempts: 0 })).toBe(false);
  });

  test('网络类错误不改投（不是容量问题）', () => {
    expect(shouldZhipuPaidFallback({ ...base, kind: 'net' })).toBe(false);
    expect(shouldZhipuPaidFallback({ ...base, kind: 'server' })).toBe(false);
  });

  test('用户关掉自动改投 → 只等待不花钱', () => {
    expect(shouldZhipuPaidFallback({ ...base, enabled: '0' })).toBe(false);
  });

  test('当前已是付费档 / 未知模型 / 兜底档本身免费 → 不改投', () => {
    expect(shouldZhipuPaidFallback({ ...base, model: 'cogvideox-2' })).toBe(false);
    expect(shouldZhipuPaidFallback({ ...base, model: 'not-exist' })).toBe(false);
    expect(shouldZhipuPaidFallback({ ...base, fallbackModel: 'cogvideox-flash' })).toBe(false);
  });
});

describe('retargetZhipuPayload（改投时只换 model，必要时回落 size）', () => {
  const payload = { model: 'cogvideox-flash', prompt: '猫', size: '1280x720', duration: '5', quality: 'speed' };

  test('目标模型支持原 size 时保持不动，且不修改入参对象', () => {
    const next = retargetZhipuPayload(payload, 'cogvideox-2');
    expect(next).toMatchObject({ model: 'cogvideox-2', size: '1280x720', duration: '5', prompt: '猫' });
    expect(payload.model).toBe('cogvideox-flash'); // 纯函数，不改入参
  });

  test('目标模型不支持原 size 时回落到其第一个规格', () => {
    const next = retargetZhipuPayload({ ...payload, size: '999x999' }, 'cogvideox-2');
    expect(next.size).toBe('1280x720');
  });

  test('未知目标模型返回 null（调用方据此放弃改投）', () => {
    expect(retargetZhipuPayload(payload, 'not-exist')).toBeNull();
    expect(retargetZhipuPayload(null, 'cogvideox-2')).toBeNull();
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
