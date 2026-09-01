'use strict';
/**
 * test/unit/setup.js —— jest setupFiles：在任何模块（含 db.js）加载前隔离文件副作用
 * db.js 在 require 时即创建数据目录并打开 SQLite，这里把 DB_PATH / DATA_DIR
 * 指向每次进程唯一的临时目录，避免单测污染真实 data/。
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(os.tmpdir(), `agnes-unit-${process.pid}`);
fs.mkdirSync(root, { recursive: true });

process.env.DATA_DIR = root;
process.env.DB_PATH = path.join(root, 'unit-test.db');
