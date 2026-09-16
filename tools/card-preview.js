#!/usr/bin/env node
'use strict';
/**
 * tools/card-preview.js —— 片头卡 / 发布封面 预览（单帧 PNG，秒级出图）
 *
 * 为什么需要：封面是"设计活"，不该靠"整集渲染 80 秒再抽帧"来试错。
 * 本工具复用 workers/render.js 导出的 `titleCardFilters`（与成片片头卡同源），
 * 只把结果渲染成一帧 PNG，用于快速比对排版与字体。
 *
 * 用法：
 *   node tools/card-preview.js --scene <图片路径或URL> --title 幻灯屋 --subtitle "S1E04 雨の音" \
 *        --creator 回忆录里的明天 --out preview.png [--ratio 16:9|9:16] [--serifFont <字体文件绝对路径>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const renderer = require('../workers/render');

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i] && argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
}

const dims = args.ratio === '9:16' ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-card-'));
const font = renderer.stageFont(tmpDir);
if (!font) {
  console.error('未找到可用中文字体（片头卡文字会被跳过）');
  process.exit(1);
}
if (args.serifFont && fs.existsSync(args.serifFont)) {
  const rel = 'font-title' + path.extname(args.serifFont);
  fs.copyFileSync(args.serifFont, path.join(tmpDir, rel));
  font.titleRel = rel;
}
const texts = {
  title: args.title || '幻灯屋',
  subtitle: args.subtitle || '',
  creator: args.creator || '',
};

const vf = [];
if (args.scene) {
  vf.push(`scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},setsar=1`);
  vf.push('eq=brightness=-0.22:saturation=0.9');
  vf.push('vignette=PI/4.2');
}
vf.push(
  ...renderer.titleCardFilters({
    dims,
    font,
    texts,
    style: {
      band: args.band !== '0', // 默认挂轴纸带（与成片一致）；--band 0 可关闭试版
      hero: args.hero === 'sans' ? 'sans' : 'serif',
      fakeBold: args.fakeBold === '1' || args.fakeBold === 'true',
    },
  }),
);

const out = path.resolve(args.out || 'card-preview.png');
const inputArgs = args.scene
  ? ['-loop', '1', '-i', args.scene]
  : [
      '-f',
      'lavfi',
      '-i',
      `nullsrc=s=${dims.w}x${dims.h},geq=lum='8+40*(0.5*X/W+0.5*Y/H)':cb='126+2*X/W':cr='127+6*Y/H',noise=alls=2:allf=t`,
    ];
const r = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-nostdin',
    '-y',
    ...inputArgs,
    '-frames:v',
    '1',
    '-vf',
    vf.join(','),
    out,
  ],
  { cwd: tmpDir, encoding: 'utf8', timeout: 240000 },
);
if (r.status !== 0 || !fs.existsSync(out)) {
  console.error('渲染失败：' + String(r.stderr || r.error || '').slice(0, 400));
  process.exit(1);
}
console.log('OK ' + out);
console.log(
  '  字体：正文 ' +
    font.rel +
    ' · 主标题 ' +
    font.titleRel +
    (font.titleRel.includes('title') ? '（衬线）' : '（回落无衬线）'),
);
