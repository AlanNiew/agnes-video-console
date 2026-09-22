'use strict';
/**
 * render-font.test.js —— 字体来源解析（无 root 主机的用户级字体）
 * 背景：云主机/容器常无中文字体且无 sudo，字体只能放家目录；
 * 若解析不到，片头/片尾卡文字会被静默跳过（不报错），故这里锁死优先级与降级行为。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findFont, findSerifFont } = require('../../workers/render');

const ENV_SANS = 'AGNES_FONT_FILE';
const ENV_SERIF = 'AGNES_SERIF_FONT_FILE';

let dir;
let saved = {};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-font-'));
  saved = { sans: process.env[ENV_SANS], serif: process.env[ENV_SERIF] };
});

afterAll(() => {
  for (const [k, v] of [
    [ENV_SANS, saved.sans],
    [ENV_SERIF, saved.serif],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AGNES_FONT_FILE 显式覆盖主字体（最高优先级）', () => {
  const f = path.join(dir, 'MyCJK.ttf');
  fs.writeFileSync(f, 'not-a-real-font');
  process.env[ENV_SANS] = f;
  expect(findFont()).toBe(f);
  delete process.env[ENV_SANS];
});

test('AGNES_SERIF_FONT_FILE 显式覆盖衬线体', () => {
  const f = path.join(dir, 'MySerif.ttf');
  fs.writeFileSync(f, 'not-a-real-font');
  process.env[ENV_SERIF] = f;
  expect(findSerifFont()).toBe(f);
  delete process.env[ENV_SERIF];
});

test('覆盖值指向不存在的文件时被跳过，不会把空路径当字体', () => {
  const ghost = path.join(dir, 'no-such-font.ttf');
  process.env[ENV_SANS] = ghost;
  process.env[ENV_SERIF] = ghost;
  try {
    // 本机可能仍有 Windows/macOS 系统字体，故只断言「不会返回那个不存在的路径」
    expect(findFont()).not.toBe(ghost);
    expect(findSerifFont()).not.toBe(ghost);
  } finally {
    delete process.env[ENV_SANS];
    delete process.env[ENV_SERIF];
  }
});

test('候选表不会因空环境变量而短路（undefined 被过滤）', () => {
  delete process.env[ENV_SANS];
  // 返回值要么是真实存在的字体路径，要么是 null；不能是 '' / undefined / 'undefined'
  const got = findFont();
  expect(got === null || fs.existsSync(got)).toBe(true);
});
