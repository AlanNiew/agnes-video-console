#!/usr/bin/env node
'use strict';
/**
 * tools/db-snapshot.js —— 一致性数据库快照（迁移/备份用）
 *
 * 为什么不用 cp：库跑在 WAL 模式下（db/kernel.js: PRAGMA journal_mode = WAL），
 * 直接复制 .db 会漏掉 -wal 里未落盘的事务，拷出来的是一份可能损坏的库。
 * VACUUM INTO 让 SQLite 自己产出一份「触发器/页结构全部重写」的单文件副本，
 * 天然跨 WAL、不带 -wal/-shm，源库可在线（无需停控制台）。
 *
 * 用法：
 *   node tools/db-snapshot.js                                   # 源库取默认，目标自动带时间戳
 *   node tools/db-snapshot.js --out D:\tmp\agnes-server.db      # 指定目标（不可已存在）
 *   node tools/db-snapshot.js --db data/e2e-test.db --out /tmp/x.db
 * 退出码：0 = 快照成功且 integrity_check 通过
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const defaultDb =
  process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'agnes-console.db');
const src = path.resolve(argOf('--db') || defaultDb);
const out = path.resolve(argOf('--out') || path.join(path.dirname(src), `snapshot-${stamp()}.db`));

if (!fs.existsSync(src)) {
  console.error(`✗ 源库不存在：${src}`);
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`✗ 目标已存在，拒绝覆盖（换个 --out 或先删掉它）：${out}`);
  process.exit(1);
}

let db;
try {
  db = new DatabaseSync(src, { readOnly: true });
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
} catch (e) {
  console.error(`✗ 快照失败：${e.message}`);
  process.exit(1);
} finally {
  db?.close();
}

const mb = (f) => (fs.statSync(f).size / 1024 ** 2).toFixed(2);
console.log(`源库：${src}（${mb(src)} MB）`);
console.log(`快照：${out}（${mb(out)} MB）`);

let chk;
try {
  chk = new DatabaseSync(out, { readOnly: true });
  const row = chk.prepare('PRAGMA integrity_check').get();
  const verdict = Object.values(row)[0];
  console.log(`完整性检查：${verdict}`);
  if (verdict !== 'ok') process.exit(1);
} catch (e) {
  console.error(`✗ 快照无法打开：${e.message}`);
  process.exit(1);
} finally {
  chk?.close();
}
console.log('✓ 快照可用（已跨 WAL，可安全 scp 到服务器）');
