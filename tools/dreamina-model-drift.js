#!/usr/bin/env node
'use strict';
/**
 * dreamina-model-drift.js —— **即梦模型清单漂移检测**（v2.6.12）
 *
 * 为什么需要：我们的模型白名单是"某一时刻从官方 CLI help 抄下来的"，而即梦会持续上新
 * （本次就是用户发现网页端已有 Seedream 5.0 Flash / 5.0 Lite / 图片美学模型 V8.2，
 *  而我们系统还停在 3.1 当主力）。模型清单必须**能被定期核对**，而不是靠人记得。
 *
 * 做法：现场执行 `dreamina <子命令> -h`，解析官方 help 里的
 *   `- model_version: a, b, c` 与 `--model_version string  supported values: ...`
 * 两处声明，与 `core/constants.js` 的 DREAMINA_MODELS / DREAMINA_IMAGE_MODELS 对账：
 *   · **missing**（官方有、我们没接）→ 提示补进白名单（可能带来更强/更划算的档位）
 *   · **extra**（我们有、官方 help 没有）→ 可能是官方已下线，或我们抄错
 * 并按 `DREAMINA_CREDIT_COST` 打印**已知单价**，便于判断性价比（未实测的标 ?）。
 *
 * 用法（服务器或本机均可，需已装 CLI；**只读、不提交、不花积分**）：
 *   node tools/dreamina-model-drift.js                 # 用 PATH 里的 dreamina
 *   DREAMINA_CLI_PATH=/home/alan/.local/bin/dreamina node tools/dreamina-model-drift.js
 * 建议纳入每周运维（与 refresh-geo 同批），模型漂移时输出即告警。
 *
 * 退出码：0=无漂移；1=发现漂移（便于 cron 告警）。
 */
const { spawnSync } = require('node:child_process');
const { DREAMINA_MODELS, DREAMINA_IMAGE_MODELS, DREAMINA_CREDIT_COST } = require('../core/constants');

const BIN = process.env.DREAMINA_CLI_PATH || 'dreamina';
/** 视频子命令 → 我们白名单里的 specs 键名（用于判断某子命令是否被支持） */
const VIDEO_SUBCOMMANDS = ['text2video', 'image2video', 'frames2video', 'multiframe2video', 'multimodal2video'];
const IMAGE_SUBCOMMANDS = ['text2image', 'image2image'];

function help(subcommand) {
  const r = spawnSync(BIN, [subcommand, '-h'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw new Error(`无法执行 ${BIN} ${subcommand} -h：${r.error.message}`);
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/** 从 help 文本里抽取该子命令支持的 model_version 取值集合 */
function parseModels(text) {
  const set = new Set();
  const line = text.match(/-\s*model_version:\s*([^\n]+)/i);
  if (line) {
    for (const m of line[1].split(',')) {
      const v = m.trim();
      if (v && !/^default/i.test(v)) set.add(v);
    }
  }
  const flag = text.match(/--model_version\s+string\s+supported values:\s*([^;\n]+)/i);
  if (flag) {
    for (const m of flag[1].split(',')) {
      const v = m.trim();
      if (v) set.add(v);
    }
  }
  return set;
}

/** 我们白名单里 model_version → 常量键，按子命令归属
 *  注意：图片档用 `model_version`（3.1 / 5.0Pro），视频档用 `modelVersion`（seedance2.0mini）
 *  —— 我们自己的命名不统一，读取时两者都要认，否则视频侧会全部误报"未接入"。 */
function oursByKind(kind) {
  const map = new Map();
  const src = kind === 'image' ? DREAMINA_IMAGE_MODELS : DREAMINA_MODELS;
  for (const [key, def] of Object.entries(src)) {
    const mv = String(def.modelVersion || def.model_version || '');
    if (!mv) continue;
    if (!map.has(mv)) map.set(mv, { key, def });
  }
  return map;
}

/** 打印已知单价（图片按档位、视频按分辨率） */
function priceHint(kind, mv) {
  const src = kind === 'image' ? DREAMINA_IMAGE_MODELS : DREAMINA_MODELS;
  const key = Object.entries(src).find(([, d]) => String(d.modelVersion || d.model_version || '') === mv)?.[0];
  if (!key) return '';
  if (kind === 'image') {
    const row = DREAMINA_CREDIT_COST.image?.[key]?.perRequest || {};
    return Object.entries(row)
      .map(([res, v]) => `${res}=${v.points}${v.source === 'measured' ? '' : '?'}`)
      .join(' ');
  }
  const override = DREAMINA_CREDIT_COST.videoByModel?.[key] || {};
  const parts = Object.entries(override).map(
    ([res, v]) => `${res}=${v.perSecond}/s${v.source === 'measured' ? '' : '?'}`,
  );
  return parts.join(' ') || '（用通用分辨率档）';
}

function checkKind(kind, subcommands) {
  const ours = oursByKind(kind);
  const seen = new Set();
  let drift = false;
  console.log(`\n════ ${kind === 'image' ? '图片' : '视频'}模型对账 ════`);
  for (const sub of subcommands) {
    let models;
    try {
      models = parseModels(help(sub));
    } catch (e) {
      console.log(`  ⚠ ${sub}: ${e.message}`);
      continue;
    }
    if (!models.size) continue;
    const missing = [...models].filter((m) => !ours.has(m));
    const extra = [...ours.keys()].filter((m) => !models.has(m) && !seen.has(m));
    for (const m of models) seen.add(m);
    console.log(`  ${sub.padEnd(17)} 官方 ${models.size} 档`);
    if (missing.length) {
      drift = true;
      console.log(`    ⚠ **未接入**: ${missing.join(', ')}`);
    }
    if (extra.length && sub === subcommands[0]) {
      console.log(`    · 我们有但该子命令未列: ${extra.join(', ')}`);
    }
  }
  // 逐个模型打印规格与单价，便于判断性价比
  console.log('  ── 白名单现状 ──');
  const src = kind === 'image' ? DREAMINA_IMAGE_MODELS : DREAMINA_MODELS;
  for (const [key, def] of Object.entries(src)) {
    const mv = String(def.model_version || '');
    const subs = kind === 'image' ? IMAGE_SUBCOMMANDS : VIDEO_SUBCOMMANDS;
    const supported = subs.filter((s) => (kind === 'image' ? true : def.specs?.[s]));
    const price = priceHint(kind, mv);
    console.log(
      `    ${key.padEnd(22)} mv=${mv.padEnd(16)} ${supported.length ? '支持:' + supported.length : ''} ${price}`,
    );
  }
  return drift;
}

function main() {
  console.log(`即梦模型清单漂移检测（CLI: ${BIN}）`);
  const v = spawnSync(BIN, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  console.log(`  版本: ${(v.stdout || '').trim().split('\n').slice(0, 2).join(' ') || '(取不到)'}`);
  const d1 = checkKind('image', IMAGE_SUBCOMMANDS);
  const d2 = checkKind('video', VIDEO_SUBCOMMANDS);
  const drift = d1 || d2;
  console.log(
    `\n${drift ? '⚠ 发现漂移：官方有新模型未接入 —— 请评估性价比后补进 core/constants.js（勿默认选最便宜的档）' : '✓ 无漂移：白名单与官方 help 一致'}`,
  );
  process.exit(drift ? 1 : 0);
}

main();
