'use strict';
/**
 * config 单元测试 —— 单源常量契约（防止各处默认值再次漂移）
 */
const {
  DEFAULT_BASE_URL,
  RENDER_PARAMS_DEFAULTS,
  probeDuration,
} = require('../../config');
const { DEFAULT_SETTINGS } = require('../../db');
const { submitter } = require('../../submitter');

describe('DEFAULT_BASE_URL 单源', () => {
  test('格式为 https 上游地址', () => {
    expect(DEFAULT_BASE_URL).toMatch(/^https:\/\/[\w.-]+/);
  });

  test('db 默认设置 base_url 与之同源', () => {
    expect(DEFAULT_SETTINGS.base_url).toBe(DEFAULT_BASE_URL);
  });
});

describe('RENDER_PARAMS_DEFAULTS 单源', () => {
  test('渲染默认参数值与历史行为一致', () => {
    expect(RENDER_PARAMS_DEFAULTS).toEqual({
      transition_ms: 600,
      narration_offset_ms: 500,
      title_card: true,
      end_card: true,
    });
  });
});

describe('probeDuration', () => {
  test('文件不存在时返回 null（不抛异常）', () => {
    expect(probeDuration('Z:/不存在的路径/no-such-file.mp4')).toBeNull();
  });

  test('非媒体文件返回 null', () => {
    // 用本测试文件自身探测：ffprobe 对纯文本会失败 → null
    expect(probeDuration(__filename)).toBeNull();
  });

  test('有效媒体返回正数秒（需要本机 ffprobe；缺失则跳过）', () => {
    const { spawnSync } = require('node:child_process');
    const has = spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
    if (!has) return; // 环境无 ffprobe：probeDuration 契约就是返回 null
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    // 生成 0.5s 静音音频作为已知时长的媒体
    const tmp = path.join(os.tmpdir(), `probe-test-${Date.now()}.wav`);
    const r = spawnSync('ffmpeg', ['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.5', tmp], { windowsHide: true });
    if (r.status !== 0) return;
    const d = probeDuration(tmp);
    fs.rmSync(tmp, { force: true });
    expect(d).not.toBeNull();
    expect(d).toBeGreaterThan(0.4);
    expect(d).toBeLessThan(0.7);
  });
});
