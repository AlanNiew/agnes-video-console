'use strict';
/**
 * 即梦成本模型与登录材料解析单元测试（docs/DREAMINA_CLI_PLAN.md 阶段 1）
 * 全部为纯函数校验：不 spawn CLI、不消耗积分。
 */
const { estimateDreaminaCost, checkDreaminaGuard } = require('../../services/payloads');
const { pickField } = require('../../clients/dreamina');
const { DREAMINA_DEFAULT_THRESHOLD } = require('../../core/constants');

describe('estimateDreaminaCost（即梦积分预估）', () => {
  test('视频按秒计费：720p 5s = 25 积分（实测标定）', () => {
    const r = estimateDreaminaCost('seedance2.0fast', { duration: 5, video_resolution: '720p' });
    expect(r.points).toBe(25);
    expect(r.confidence).toBe('measured');
    expect(r.breakdown).toContain('720p');
  });

  test('视频成本随时长线性增长', () => {
    expect(estimateDreaminaCost('seedance2.0fast', { duration: 15, video_resolution: '720p' }).points).toBe(75);
  });

  test('图片按「次」计费，与 count 无关（实测一次请求返回 4 张候选）', () => {
    const one = estimateDreaminaCost('jimeng-image-3.1', { size: '1k', count: 1 });
    const four = estimateDreaminaCost('jimeng-image-3.1', { size: '1k', count: 4 });
    expect(one.points).toBe(1);
    expect(four.points).toBe(1); // 关键：不随 count 增长
    expect(one.confidence).toBe('measured');
  });

  test('seconds 别名与缺省值（默认 5s / 720p）', () => {
    expect(estimateDreaminaCost('seedance2.0fast', { seconds: 10 }).points).toBe(50);
    expect(estimateDreaminaCost('seedance2.0fast', {}).points).toBe(25);
  });

  test('未实测的规格标注 estimated（UI 需提示"实际以扣费为准"）', () => {
    const r = estimateDreaminaCost('jimeng-image-5.0', { size: '2k' });
    expect(r.points).toBe(3);
    expect(r.confidence).toBe('estimated');
  });

  test('未知规格返回 points=null（调用方据此走保守确认）', () => {
    expect(estimateDreaminaCost('seedance2.0fast', { video_resolution: '999p' }).points).toBeNull();
  });

  test('非即梦模型返回 null（不参与成本护栏）', () => {
    expect(estimateDreaminaCost('agnes-video-2.5-flash', {})).toBeNull();
    expect(estimateDreaminaCost('', {})).toBeNull();
  });
});

describe('checkDreaminaGuard（成本护栏三档）', () => {
  const VIDEO = { duration: 5, video_resolution: '720p' }; // 25 积分
  const IMAGE = { size: '1k' }; // 1 积分

  test('额度少 → pass（静默通过，不打扰）', () => {
    expect(checkDreaminaGuard('jimeng-image-3.1', IMAGE, { threshold: 10, remainingCredit: 734 }).level).toBe('pass');
  });

  test('超阈值 → confirm（需前端弹窗确认）', () => {
    const r = checkDreaminaGuard('seedance2.0fast', VIDEO, { threshold: 10, remainingCredit: 734 });
    expect(r.level).toBe('confirm');
    expect(r.points).toBe(25);
    expect(r.threshold).toBe(10);
    expect(r.remaining).toBe(734);
  });

  test('余额不足 → block（优先级高于 confirm）', () => {
    expect(checkDreaminaGuard('seedance2.0fast', VIDEO, { threshold: 10, remainingCredit: 5 }).level).toBe('block');
  });

  test('阈值 0 → 任何即梦调用都需确认（最严）', () => {
    expect(checkDreaminaGuard('jimeng-image-3.1', IMAGE, { threshold: 0 }).level).toBe('confirm');
  });

  test('极大阈值 → 从不确认', () => {
    expect(checkDreaminaGuard('seedance2.0fast', VIDEO, { threshold: 999999 }).level).toBe('pass');
  });

  test('无法预估 → 保守走 confirm', () => {
    const r = checkDreaminaGuard('seedance2.0fast', { video_resolution: '999p' }, { threshold: 10 });
    expect(r.level).toBe('confirm');
    expect(r.points).toBeNull();
  });

  test('未提供 remaining 时仅按阈值判定', () => {
    expect(checkDreaminaGuard('seedance2.0fast', VIDEO, { threshold: 100 }).level).toBe('pass');
  });

  test('缺省阈值取 DREAMINA_DEFAULT_THRESHOLD', () => {
    expect(checkDreaminaGuard('jimeng-image-3.1', IMAGE).threshold).toBe(DREAMINA_DEFAULT_THRESHOLD);
  });

  test('非即梦模型返回 null（Agnes 调用零打扰）', () => {
    expect(checkDreaminaGuard('agnes-video-2.5-flash', {}, {})).toBeNull();
  });
});

describe('pickField（login 系列文本输出解析）', () => {
  // 实测样本：login --headless 输出的是 key: value 文本，而非 JSON
  const SAMPLE = [
    '请使用浏览器完成 OAuth Device Flow 登录。',
    'verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?x=1',
    'user_code: 555b75f291899c23c1a778cd893dd403',
    'device_code: 315613ca953f744a6fbe7d5c823004e3',
    'poll_interval: 1s',
    'expires_at: 2026-09-16T13:57:42+08:00',
  ].join('\n');

  test('从实测样本文本中提取授权材料', () => {
    expect(pickField(SAMPLE, 'user_code')).toBe('555b75f291899c23c1a778cd893dd403');
    expect(pickField(SAMPLE, 'device_code')).toBe('315613ca953f744a6fbe7d5c823004e3');
    expect(pickField(SAMPLE, 'poll_interval')).toBe('1s');
    expect(pickField(SAMPLE, 'verification_uri')).toContain('cli-auth');
  });

  test('缺失字段或空输入返回 null', () => {
    expect(pickField(SAMPLE, 'nope')).toBeNull();
    expect(pickField('', 'device_code')).toBeNull();
    expect(pickField(null, 'device_code')).toBeNull();
  });

  test('checklogin 输出同样可解析账户信息', () => {
    const done = ['OAuth 登录成功。', 'user_id: 991111216374787', 'vip_level: standard', 'total_credit: 761'].join(
      '\n',
    );
    expect(pickField(done, 'user_id')).toBe('991111216374787');
    expect(pickField(done, 'vip_level')).toBe('standard');
    expect(Number(pickField(done, 'total_credit'))).toBe(761);
  });
});
