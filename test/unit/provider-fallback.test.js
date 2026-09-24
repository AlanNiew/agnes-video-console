'use strict';
/**
 * 即梦「可用性 / 回退免费档」策略单元测试（v2.6.1）
 * 全部为纯函数校验：不 spawn CLI、不消耗积分、不触网。
 * 规则来源：用户口径 + 《幻灯屋》台账 §七——
 *   会过期的即梦额度先用；积分不足 / 生成失败 / 非 VIP / 环境未就绪 → 回退免费档（Agnes）。
 */
const {
  estimateDreaminaCost,
  checkDreaminaGuard,
  dreaminaToAgnes,
  agnesToDreamina,
} = require('../../services/payloads');
const {
  FREE_VIDEO_MODEL,
  FREE_IMAGE_MODEL,
  dreaminaUsable,
  shouldFallbackFromDreamina,
  shouldFallbackToDreamina,
  clampFreeSeconds,
  freeVideoSize,
  fallbackReasonText,
  toDreaminaReasonText,
} = require('../../core/provider-policy');

describe('价目表按模型分档（E06 实测标定）', () => {
  test('seedance2.0 720p = 8 积分/秒（实测：10s 实扣 80）', () => {
    const r = estimateDreaminaCost('seedance2.0', { duration: 10, video_resolution: '720p' });
    expect(r.points).toBe(80);
    expect(r.confidence).toBe('measured');
    expect(r.breakdown).toContain('seedance2.0');
  });

  test('seedance2.0fast 720p 仍走分辨率默认档 5 积分/秒（旧标定不回退）', () => {
    expect(estimateDreaminaCost('seedance2.0fast', { duration: 5, video_resolution: '720p' }).points).toBe(25);
  });

  test('同一分辨率不同代际单价不同 —— 只按分辨率取值会低报 60%', () => {
    const slow = estimateDreaminaCost('seedance2.0fast', { duration: 10, video_resolution: '720p' }).points;
    const full = estimateDreaminaCost('seedance2.0', { duration: 10, video_resolution: '720p' }).points;
    expect(full).toBe(80);
    expect(slow).toBe(50);
    expect(full / slow).toBeCloseTo(1.6, 2);
  });

  test('未覆盖的模型/分辨率仍回落默认档（向后兼容）', () => {
    expect(estimateDreaminaCost('seedance2.0', { duration: 5, video_resolution: '480p' }).points).toBe(15);
  });
});

describe('checkDreaminaGuard（level 契约不变 + 新增回退建议）', () => {
  const VIDEO10 = { duration: 10, video_resolution: '720p' }; // seedance2.0 = 80 积分

  test('额度不足：level=block（契约不变）且给出回退建议', () => {
    const g = checkDreaminaGuard('seedance2.0', VIDEO10, { threshold: 10, remainingCredit: 50 });
    expect(g.level).toBe('block');
    expect(g.fallback).toEqual({ model: FREE_VIDEO_MODEL, reason: 'insufficient-credit' });
    expect(g.free_model).toBe(FREE_VIDEO_MODEL);
    expect(g.kind).toBe('video');
  });

  test('额度充足：level=confirm，且不误报回退', () => {
    const g = checkDreaminaGuard('seedance2.0', VIDEO10, { threshold: 10, remainingCredit: 500 });
    expect(g.level).toBe('confirm');
    expect(g.fallback).toBeUndefined();
  });

  test('非 VIP：给出 not-vip 回退建议（额度够也不再花付费档）', () => {
    const g = checkDreaminaGuard(
      'jimeng-image-3.1',
      { size: '1k' },
      { threshold: 10, remainingCredit: 500, vipLevel: '' },
    );
    expect(g.fallback).toEqual({ model: FREE_IMAGE_MODEL, reason: 'not-vip' });
  });

  test('VIP：无回退建议', () => {
    const g = checkDreaminaGuard(
      'jimeng-image-3.1',
      { size: '1k' },
      { threshold: 10, remainingCredit: 500, vipLevel: 'standard' },
    );
    expect(g.level).toBe('pass');
    expect(g.fallback).toBeUndefined();
  });

  test('非即梦模型不参与护栏（Agnes 零打扰）', () => {
    expect(checkDreaminaGuard('agnes-video-2.5-flash', {}, {})).toBeNull();
  });
});

describe('dreaminaUsable（提交前可用性）', () => {
  test('未安装 / 未登录 / 非 VIP / 开关关闭 分别给出原因', () => {
    expect(dreaminaUsable({ installed: false, loggedIn: true, vipLevel: 'standard' }).reason).toBe('not-installed');
    expect(dreaminaUsable({ installed: true, loggedIn: false, vipLevel: 'standard' }).reason).toBe('not-logged-in');
    expect(dreaminaUsable({ installed: true, loggedIn: true, vipLevel: 'none' }).reason).toBe('not-vip');
    expect(dreaminaUsable({ installed: true, loggedIn: true, vipLevel: 'standard', enabled: false }).reason).toBe(
      'disabled',
    );
  });

  test('环境齐备 → 可用', () => {
    const r = dreaminaUsable({ installed: true, loggedIn: true, vipLevel: 'standard' });
    expect(r).toEqual({ usable: true, reason: null });
  });
});

describe('shouldFallbackToDreamina（v2.6.7 反向回退：Agnes 排队失败 → 即梦）', () => {
  test('队列满 / 限流 / 网络重试耗尽 → 改投即梦', () => {
    for (const k of ['queue-full', 'rate-limit', 'net']) {
      expect(shouldFallbackToDreamina(k, { enabled: true })).toEqual({ fallback: true, reason: k });
    }
  });

  test('内容/参数类失败不改投（即梦同样会拒，改了只是花钱）', () => {
    for (const k of ['bad-args', 'auth', 'content-policy', '', undefined]) {
      expect(shouldFallbackToDreamina(k, { enabled: true }).fallback).toBe(false);
    }
  });

  test('设置项关闭时永不改投（默认关闭：会消耗会员积分）', () => {
    expect(shouldFallbackToDreamina('queue-full', { enabled: false }).fallback).toBe(false);
  });

  test('原因文案可读', () => {
    expect(toDreaminaReasonText('queue-full')).toContain('队列');
    expect(toDreaminaReasonText('too-many-reference-images')).toContain('参考图');
  });
});

describe('agnesToDreamina（Agnes 任务 → 即梦任务映射）', () => {
  const base = {
    prompt: '黄昏的渡口，旧提灯被点亮',
    seconds: '5',
    size: '720P',
    aspect_ratio: '16:9',
    request_json: { model: 'agnes-video-2.5-flash', prompt: '黄昏的渡口，旧提灯被点亮', seconds: '5' },
  };

  test('纯文生任务可映射：落到即梦默认主力档 + 720p + 同画幅', () => {
    const r = agnesToDreamina(base);
    expect(r.ok).toBe(true);
    expect(r.model).toBe('seedance2.0mini');
    expect(r.size).toBe('720p');
    expect(r.seconds).toBe('5');
    expect(r.aspect_ratio).toBe('16:9');
    expect(r.request_json.provider).toBe('dreamina');
    expect(r.request_json.prompt).toBe(base.prompt);
  });

  test('带参考图的任务**照常改投**，映射为即梦全能参考（v2.6.8）', () => {
    const r = agnesToDreamina({ ...base, request_json: { ...base.request_json, images: ['https://a.com/c.png'] } });
    expect(r.ok).toBe(true);
    expect(r.request_json.subcommand).toBe('multimodal2video');
    expect(r.request_json.images).toEqual(['https://a.com/c.png']);
    // 首帧图（image/first_frame）同样按参考素材处理，语义仍是全能参考
    const r2 = agnesToDreamina({ ...base, request_json: { ...base.request_json, first_frame: 'https://a.com/f.png' } });
    expect(r2.ok).toBe(true);
    expect(r2.request_json.images).toEqual(['https://a.com/f.png']);
  });

  test('缺提示词 → 不映射', () => {
    expect(agnesToDreamina({ seconds: '5' })).toEqual({ ok: false, reason: 'no-prompt' });
  });

  test('时长超界按目标模型 spec 钳制并记 notes', () => {
    const r = agnesToDreamina({ ...base, seconds: '30' });
    expect(r.ok).toBe(true);
    expect(r.seconds).toBe('15'); // seedance2.0mini 上限 15s
    expect(r.notes.join()).toContain('15s');
  });

  test('非法画幅回落 16:9', () => {
    const r = agnesToDreamina({ ...base, aspect_ratio: '5:4' });
    expect(r.ok).toBe(true);
    expect(r.aspect_ratio).toBe('16:9');
  });
});

describe('shouldFallbackFromDreamina（失败后是否改投免费档）', () => {
  test('环境未就绪 / 合规闸门 / 参数错 / 业务错 → 立即回退', () => {
    for (const k of ['not-installed', 'not-logged-in', 'need-web-confirm', 'bad-args', 'cli-error']) {
      expect(shouldFallbackFromDreamina(k, { enabled: true }).fallback).toBe(true);
    }
  });

  test('瞬时错误先重试，重试耗尽才回退', () => {
    expect(shouldFallbackFromDreamina('timeout', { attempts: 1, maxAttempts: 3 }).fallback).toBe(false);
    expect(shouldFallbackFromDreamina('timeout', { attempts: 3, maxAttempts: 3 }).fallback).toBe(true);
    expect(shouldFallbackFromDreamina('spawn-error', { attempts: 5, maxAttempts: 5 }).fallback).toBe(true);
  });

  test('设置项关闭 → 永不回退（保留旧的退避等人工行为）', () => {
    const r = shouldFallbackFromDreamina('not-installed', { enabled: false });
    expect(r.fallback).toBe(false);
    expect(r.retry).toBe(true);
  });

  test('回退原因有可读文案', () => {
    expect(fallbackReasonText('insufficient-credit')).toContain('积分不足');
    expect(fallbackReasonText('not-vip')).toContain('VIP');
    expect(fallbackReasonText('未知原因')).toContain('即梦不可用');
  });
});

describe('dreaminaToAgnes（即梦任务 → 免费档任务映射）', () => {
  test('视频无首帧 → 文生模式，提示词原样保留', () => {
    const m = dreaminaToAgnes('video', {
      prompt: '秋夜的河堤',
      seconds: 10,
      size: '720p',
      aspect_ratio: '16:9',
      request_json: { model: 'seedance2.0', duration: 10, videoResolution: '720p' },
    });
    expect(m.model).toBe(FREE_VIDEO_MODEL);
    expect(m.request_json.mode).toBe('text');
    expect(m.request_json.prompt).toBe('秋夜的河堤');
    expect(m.request_json.seconds).toBe('10');
    expect(m.request_json.size).toBe('720P');
  });

  test('公网首帧 → keyframe 模式并保留 first_frame', () => {
    const m = dreaminaToAgnes('video', {
      prompt: 'x',
      seconds: 5,
      request_json: { image: 'https://cdn.example.com/a.png' },
    });
    expect(m.request_json.mode).toBe('keyframe');
    expect(m.request_json.first_frame).toBe('https://cdn.example.com/a.png');
  });

  test('本地路径首帧 → 降级纯文生并记 note（Agnes 取不到本地文件）', () => {
    const m = dreaminaToAgnes('video', {
      prompt: 'x',
      seconds: 5,
      request_json: { image: 'D:\\tmp\\a.png' },
    });
    expect(m.request_json.mode).toBe('text');
    expect(m.request_json.first_frame).toBeUndefined();
    expect(m.notes.join()).toContain('降级');
  });

  test('超长时长与受限分辨率被钳制到免费档规格', () => {
    const m = dreaminaToAgnes('video', { prompt: 'x', seconds: 15, size: '1080p' });
    expect(m.seconds).toBe('12');
    expect(m.size).toBe('720P');
    expect(m.notes.length).toBe(2);
  });

  test('图片映射：分辨率归一化 + count 保留 + 场景用途保留', () => {
    const m = dreaminaToAgnes('image', {
      prompt: 'x',
      size: '2k',
      aspect_ratio: '16:9',
      request_json: { count: 1, image_kind: 'scene' },
    });
    expect(m.model).toBe(FREE_IMAGE_MODEL);
    expect(m.size).toBe('2K');
    expect(m.ratio).toBe('16:9');
    expect(m.request_json.count).toBe(1);
    expect(m.request_json.image_kind).toBe('scene');
  });

  test('无提示词 → null（调用方据此如实落失败，而不是空转）', () => {
    expect(dreaminaToAgnes('video', { seconds: 5, request_json: {} })).toBeNull();
  });
});

describe('免费档规格钳制工具', () => {
  test('clampFreeSeconds 落在 4–12', () => {
    expect([3, 4, 10, 12, 30].map(clampFreeSeconds)).toEqual([4, 4, 10, 12, 12]);
  });
  test('freeVideoSize 仅认 720P，其余回落首个合法值', () => {
    expect(freeVideoSize('720P')).toBe('720P');
    expect(freeVideoSize('1080p')).toBe('720P');
    expect(freeVideoSize('')).toBe('720P');
  });
});
