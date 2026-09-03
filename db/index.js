'use strict';
/**
 * db/index.js —— 数据层组合入口（M3-P3：根 db.js 迁入 db/ 目录，Node 目录 index 解析）
 * 保持历史导出契约不变：{ db, settings, tasks, projects, renders, tx,
 * DEFAULT_SETTINGS, DB_PATH, DATA_DIR }——外部 19 处 require('./db') 与 instance-lock.js 零改动。
 * 实现分布：db/kernel.js（连接/DDL/迁移/tx）· db/sql.js（prepare 注册表）
 *           · db/repos/{settings,tasks,projects,renders}.js（表族仓库）。
 * import 即副作用：require 本模块即开库（单测前先设 DATA_DIR/DB_PATH）。
 */
const { db, tx, DB_PATH, DATA_DIR } = require('./kernel');
const { settings, DEFAULT_SETTINGS } = require('./repos/settings');
const tasks = require('./repos/tasks');
const projects = require('./repos/projects');
const renders = require('./repos/renders');

module.exports = { db, settings, tasks, projects, renders, tx, DEFAULT_SETTINGS, DB_PATH, DATA_DIR };
