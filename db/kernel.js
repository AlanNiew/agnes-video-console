'use strict';
/**
 * db/kernel.js —— SQLite 内核（M3-P3 自根 db.js 拆出）
 * 连接 + PRAGMA + schema DDL + 自动迁移 + parseJson + tx。
 * import 即副作用：require 即 mkdir 数据目录并开库，单测前须先设 DATA_DIR/DB_PATH
 * （jest setup.js 已处理）。本文件位于 db/ 下，默认数据目录指向仓库根 data/。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'agnes-console.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  status             TEXT    NOT NULL DEFAULT 'queued',
  kind               TEXT    DEFAULT 'video',
  mode               TEXT    NOT NULL DEFAULT 'text',
  model              TEXT    NOT NULL DEFAULT 'agnes-video-2.5-flash',
  prompt             TEXT    NOT NULL DEFAULT '',
  seconds            TEXT,
  size               TEXT    DEFAULT '720P',
  aspect_ratio       TEXT    DEFAULT '16:9',
  seed               INTEGER,
  first_frame        TEXT,
  last_frame         TEXT,
  images             TEXT,
  audios             TEXT,
  videos             TEXT,
  request_json       TEXT,
  task_id            TEXT,
  video_id           TEXT,
  progress           INTEGER DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  submit_response    TEXT,
  last_poll_response TEXT,
  metadata_url       TEXT,
  error_message      TEXT,
  poll_count         INTEGER DEFAULT 0,
  last_polled_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  idea TEXT,
  style TEXT,
  aspect_ratio TEXT,
  seconds TEXT,
  status TEXT DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  selected INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ptexts_project ON project_texts(project_id);
CREATE TABLE IF NOT EXISTS project_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  prompt TEXT,
  remote_url TEXT,
  local_path TEXT,
  size TEXT,
  ratio TEXT,
  model TEXT,
  selected INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pimgs_project ON project_images(project_id);

CREATE TABLE IF NOT EXISTS shots (       -- M2：分镜工作副本（逐镜头编辑/排序/任务溯源）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,        -- 镜头顺序（从 1 起）
  title TEXT,
  video_prompt TEXT NOT NULL DEFAULT '',
  seconds TEXT,
  mode TEXT DEFAULT 'reference',         -- 预留 reference|text|keyframe
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id);

CREATE TABLE IF NOT EXISTS project_tts (      -- TTS 配音记录（Fish Audio）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'narration',              -- narration=整片旁白 | shot=单镜头台词
  shot_id INTEGER,                            -- 绑定镜头（kind=shot 时指向 shots.id，成片渲染按镜头取旁白）
  text TEXT NOT NULL,                          -- 合成原文
  model TEXT,                                  -- tts 模型（s2.1-pro-free 等）
  reference_id TEXT,                           -- 音色模型 id（Fish voice id，缺省=平台默认音色）
  voice_title TEXT,                            -- 音色名（展示用）
  format TEXT DEFAULT 'mp3',
  local_path TEXT,                             -- 本地音频文件
  duration REAL,                               -- 音频时长（秒）
  size INTEGER,                                -- 字节数
  error_message TEXT,                          -- 生成失败信息
  selected INTEGER DEFAULT 0,                  -- 选用标记
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ptts_project ON project_tts(project_id);

CREATE TABLE IF NOT EXISTS render_jobs (      -- v1.3 成片渲染任务
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',      -- queued | rendering | completed | failed
  params TEXT,                                 -- JSON：transition_ms / narration_offset_ms / title_card / end_card
  progress INTEGER DEFAULT 0,                  -- 0–100（由 ffmpeg -progress 回写）
  output_path TEXT,                            -- 成片本地路径（data/artifacts）
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rjobs_project ON render_jobs(project_id);
`);
// 迁移：为旧版本数据库补充 agnes-video-v2.0 相关列（CREATE TABLE IF NOT EXISTS 不会追加列）
const existingCols = new Set(
  db
    .prepare('PRAGMA table_info(tasks)')
    .all()
    .map((r) => r.name),
);
const MIGRATE_COLS = [
  ['image', 'TEXT'], // v2.0 图生视频：单张图片 URL
  ['num_frames', 'INTEGER'], // v2.0 帧数（8n+1，≤441）
  ['frame_rate', 'REAL'], // v2.0 帧率（1–60）
  ['width', 'INTEGER'], // v2.0 宽
  ['height', 'INTEGER'], // v2.0 高
  ['negative_prompt', 'TEXT'], // v2.0 反向提示词
  ['project_id', 'INTEGER'], // 流水线项目关联（M1）
  ['shot_id', 'INTEGER'], // 镜头溯源（M2）
  ['text_id', 'INTEGER'], // 提示词文本版本溯源（M2）
  ['image_id', 'INTEGER'], // 引用图片溯源（M2）
  ['kind', "TEXT DEFAULT 'video'"], // 任务类型：video | image（P1 图片任务统一进任务体系；存量行 NULL 视为 video）
  ['retry_count', 'INTEGER NOT NULL DEFAULT 0'], // 手动重试次数（原任务原地重新入队，不再新建记录）
];
for (const [name, type] of MIGRATE_COLS) {
  if (!existingCols.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
}
// M2 溯源索引（列由上方迁移补齐后再建，避免旧库启动失败）
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_shot ON tasks(shot_id)');

// 迁移：v1.3 提交队列 / 视频本地归档 / 分镜旁白 / 镜头引用开关 / TTS 镜头绑定
for (const [name, type] of [
  ['submitted_at', 'INTEGER'], // 真正提交上游成功的时间（提交队列下 poller 超时以此为基准）
  ['video_local_path', 'TEXT'], // 完成视频的本地归档路径（远端 metadata_url 会过期）
]) {
  if (!existingCols.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
}
const shotCols = new Set(
  db
    .prepare('PRAGMA table_info(shots)')
    .all()
    .map((r) => r.name),
);
for (const [name, type] of [
  ['narration', 'TEXT'], // 镜头旁白文案
  ['use_character_ref', 'INTEGER DEFAULT 1'], // 是否引用角色定稿图（0 = 纯空镜，text 模式提交）
  ['take_task_id', 'INTEGER'], // v1.7 重拍定稿：选定的 take 任务 id（NULL = 自动用最新完成条）
]) {
  if (!shotCols.has(name)) db.exec(`ALTER TABLE shots ADD COLUMN ${name} ${type}`);
}
const rjobCols = new Set(
  db
    .prepare('PRAGMA table_info(render_jobs)')
    .all()
    .map((r) => r.name),
);
if (!rjobCols.has('covers')) db.exec('ALTER TABLE render_jobs ADD COLUMN covers TEXT'); // v1.8 封面候选 JSON

const ttsCols = new Set(
  db
    .prepare('PRAGMA table_info(project_tts)')
    .all()
    .map((r) => r.name),
);
if (!ttsCols.has('shot_id')) db.exec('ALTER TABLE project_tts ADD COLUMN shot_id INTEGER');
// v2.3 逐镜旁白偏移（毫秒）：角色对白镜在画面人物开口时点响，缺省=渲染全局 offset（对白同步用）
if (!ttsCols.has('offset_ms')) db.exec('ALTER TABLE project_tts ADD COLUMN offset_ms INTEGER');
// v1.4：项目背景音乐选择（JSON：song_id/name/artist/album/level/local_path 等）
const projCols = new Set(
  db
    .prepare('PRAGMA table_info(projects)')
    .all()
    .map((r) => r.name),
);
if (!projCols.has('bgm')) db.exec('ALTER TABLE projects ADD COLUMN bgm TEXT');
// P3：全自动成片状态机（JSON：{running, stage, attempts, error, history[]}）
if (!projCols.has('auto_state')) db.exec('ALTER TABLE projects ADD COLUMN auto_state TEXT');
// P3：成片质检报告（JSON：{duration_s, expected_duration_s, loudness_lufs, shots, narrated_shots, sub_lines}）
if (!rjobCols.has('quality')) db.exec('ALTER TABLE render_jobs ADD COLUMN quality TEXT');
// v2.2：作品归档目录（成片/字幕/台词/海报按作品存放于 data/works/《名》-id/）
if (!rjobCols.has('work_dir')) db.exec('ALTER TABLE render_jobs ADD COLUMN work_dir TEXT');
/** 安全解析 JSON 列 */
function parseJson(text) {
  if (text === null || text === undefined || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 多步写事务：任一步失败自动回滚（node:sqlite 同步连接，事务只为保证多语句原子性） */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}
module.exports = { db, parseJson, tx, DB_PATH, DATA_DIR };
