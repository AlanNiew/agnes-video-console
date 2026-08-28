'use strict';
/**
 * db.js —— SQLite 数据层（使用 Node 内置 node:sqlite，零原生依赖）
 * 数据文件默认位于 ./data/agnes-console.db（可用环境变量 DB_PATH 覆盖）
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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
`);

// 迁移：为旧版本数据库补充 agnes-video-v2.0 相关列（CREATE TABLE IF NOT EXISTS 不会追加列）
const existingCols = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name));
const MIGRATE_COLS = [
  ['image', 'TEXT'],            // v2.0 图生视频：单张图片 URL
  ['num_frames', 'INTEGER'],    // v2.0 帧数（8n+1，≤441）
  ['frame_rate', 'REAL'],       // v2.0 帧率（1–60）
  ['width', 'INTEGER'],         // v2.0 宽
  ['height', 'INTEGER'],        // v2.0 高
  ['negative_prompt', 'TEXT'],  // v2.0 反向提示词
];
for (const [name, type] of MIGRATE_COLS) {
  if (!existingCols.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
}

const stmts = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  insertTask: db.prepare(`
    INSERT INTO tasks (status, mode, model, prompt, seconds, size, aspect_ratio, seed,
                       first_frame, last_frame, images, audios, videos, request_json,
                       image, num_frames, frame_rate, width, height, negative_prompt,
                       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  listTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR prompt LIKE ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `),
  listAll: db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'),
  activeTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('queued','in_progress') AND video_id IS NOT NULL AND video_id != ''
    ORDER BY created_at ASC
  `),
  stuckTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('queued','in_progress') AND (video_id IS NULL OR video_id = '')
    ORDER BY created_at ASC
  `),
  countByStatus: db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status'),
  totalCount: db.prepare('SELECT COUNT(*) AS n FROM tasks'),
  updateTask: db.prepare(`
    UPDATE tasks SET
      status = ?, mode = ?, model = ?, prompt = ?, seconds = ?, size = ?, aspect_ratio = ?,
      seed = ?, first_frame = ?, last_frame = ?, images = ?, audios = ?, videos = ?,
      request_json = ?, task_id = ?, video_id = ?, progress = ?, updated_at = ?, completed_at = ?,
      submit_response = ?, last_poll_response = ?, metadata_url = ?, error_message = ?,
      poll_count = ?, last_polled_at = ?,
      image = ?, num_frames = ?, frame_rate = ?, width = ?, height = ?, negative_prompt = ?
    WHERE id = ?
  `),
  touchPoll: db.prepare(`
    UPDATE tasks SET poll_count = poll_count + 1, last_polled_at = ?, updated_at = ? WHERE id = ?
  `),
  setPollResult: db.prepare(`
    UPDATE tasks SET status = ?, progress = ?, updated_at = ?, completed_at = ?,
      last_poll_response = ?, metadata_url = ?, error_message = ?
    WHERE id = ?
  `),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  clearCompleted: db.prepare("DELETE FROM tasks WHERE status = 'completed'"),
  clearAll: db.prepare('DELETE FROM tasks'),
};

/** 安全解析 JSON 列 */
function parseJson(text) {
  if (text === null || text === undefined || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 将数据库行转换为对前端友好的任务对象 */
function toTaskRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    mode: row.mode,
    model: row.model,
    prompt: row.prompt,
    seconds: row.seconds,
    size: row.size,
    aspect_ratio: row.aspect_ratio,
    seed: row.seed === null ? null : Number(row.seed),
    first_frame: row.first_frame,
    last_frame: row.last_frame,
    images: parseJson(row.images) || [],
    audios: parseJson(row.audios) || [],
    videos: parseJson(row.videos) || [],
    request_json: parseJson(row.request_json),
    task_id: row.task_id,
    video_id: row.video_id,
    progress: Number(row.progress || 0),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    completed_at: row.completed_at === null ? null : Number(row.completed_at),
    submit_response: parseJson(row.submit_response),
    last_poll_response: parseJson(row.last_poll_response),
    metadata_url: row.metadata_url,
    error_message: row.error_message,
    poll_count: Number(row.poll_count || 0),
    last_polled_at: row.last_polled_at === null ? null : Number(row.last_polled_at),
    image: row.image,
    num_frames: row.num_frames === null ? null : Number(row.num_frames),
    frame_rate: row.frame_rate === null ? null : Number(row.frame_rate),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    negative_prompt: row.negative_prompt,
  };
}

const settings = {
  get(key, fallback = null) {
    const r = stmts.getSetting.get(key);
    return r ? r.value : fallback;
  },
  set(key, value) {
    stmts.setSetting.run(key, String(value));
  },
};

const tasks = {
  insert({ status, mode, model, prompt, seconds, size, aspect_ratio, seed, first_frame,
           last_frame, images, audios, videos, request_json,
           image, num_frames, frame_rate, width, height, negative_prompt }) {
    const now = Date.now();
    const r = stmts.insertTask.run(
      status, mode, model, prompt, seconds, size, aspect_ratio,
      seed === null || seed === undefined ? null : Number(seed),
      first_frame || null, last_frame || null,
      JSON.stringify(images || []), JSON.stringify(audios || []), JSON.stringify(videos || []),
      request_json ? JSON.stringify(request_json) : null,
      image || null,
      num_frames === null || num_frames === undefined ? null : Number(num_frames),
      frame_rate === null || frame_rate === undefined ? null : Number(frame_rate),
      width === null || width === undefined ? null : Number(width),
      height === null || height === undefined ? null : Number(height),
      negative_prompt || null,
      now, now
    );
    return Number(r.lastInsertRowid);
  },

  get(id) {
    return toTaskRow(stmts.getTask.get(Number(id)));
  },

  list({ status = null, q = null, limit = 100, offset = 0, includeAll = false } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = includeAll
      ? stmts.listAll.all(lim, off)
      : stmts.listTasks.all(status, status, q ? `%${q}%` : null, lim, off);
    return rows.map(toTaskRow);
  },

  active() {
    return stmts.activeTasks.all().map(toTaskRow);
  },

  /** 已提交但从未获得 video_id 的悬空任务（进程中断等） */
  stuck(olderThanMs = 60 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    return stmts.stuckTasks
      .all()
      .map(toTaskRow)
      .filter((t) => t.created_at < cutoff);
  },

  stats() {
    const rows = stmts.countByStatus.all();
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = Number(r.n);
    const total = Number(stmts.totalCount.get().n);
    const active = (byStatus.queued || 0) + (byStatus.in_progress || 0);
    return {
      total,
      active,
      byStatus,
      completed: byStatus.completed || 0,
      failed: (byStatus.failed || 0) + (byStatus.submit_error || 0),
    };
  },

  update(id, patch = {}) {
    const cur = stmts.getTask.get(Number(id));
    if (!cur) return false;
    const now = Date.now();
    const p = patch;
    stmts.updateTask.run(
      p.status !== undefined ? p.status : cur.status,
      p.mode !== undefined ? p.mode : cur.mode,
      p.model !== undefined ? p.model : cur.model,
      p.prompt !== undefined ? p.prompt : cur.prompt,
      p.seconds !== undefined ? p.seconds : cur.seconds,
      p.size !== undefined ? p.size : cur.size,
      p.aspect_ratio !== undefined ? p.aspect_ratio : cur.aspect_ratio,
      p.seed !== undefined ? p.seed : cur.seed,
      p.first_frame !== undefined ? p.first_frame : cur.first_frame,
      p.last_frame !== undefined ? p.last_frame : cur.last_frame,
      p.images !== undefined ? JSON.stringify(p.images) : cur.images,
      p.audios !== undefined ? JSON.stringify(p.audios) : cur.audios,
      p.videos !== undefined ? JSON.stringify(p.videos) : cur.videos,
      p.request_json !== undefined ? JSON.stringify(p.request_json) : cur.request_json,
      p.task_id !== undefined ? p.task_id : cur.task_id,
      p.video_id !== undefined ? p.video_id : cur.video_id,
      p.progress !== undefined ? p.progress : cur.progress,
      now,
      p.completed_at !== undefined ? p.completed_at : cur.completed_at,
      p.submit_response !== undefined
        ? JSON.stringify(p.submit_response)
        : cur.submit_response,
      p.last_poll_response !== undefined
        ? JSON.stringify(p.last_poll_response)
        : cur.last_poll_response,
      p.metadata_url !== undefined ? p.metadata_url : cur.metadata_url,
      p.error_message !== undefined ? p.error_message : cur.error_message,
      p.poll_count !== undefined ? p.poll_count : cur.poll_count,
      p.last_polled_at !== undefined ? p.last_polled_at : cur.last_polled_at,
      p.image !== undefined ? p.image : cur.image,
      p.num_frames !== undefined ? p.num_frames : cur.num_frames,
      p.frame_rate !== undefined ? p.frame_rate : cur.frame_rate,
      p.width !== undefined ? p.width : cur.width,
      p.height !== undefined ? p.height : cur.height,
      p.negative_prompt !== undefined ? p.negative_prompt : cur.negative_prompt,
      Number(id)
    );
    return true;
  },

  touchPoll(id) {
    const now = Date.now();
    stmts.touchPoll.run(now, now, Number(id));
  },

  setPollResult(id, { status, progress, completed_at, last_poll_response, metadata_url, error_message }) {
    stmts.setPollResult.run(
      status,
      progress !== undefined ? progress : 0,
      Date.now(),
      completed_at !== undefined ? completed_at : null,
      last_poll_response ? JSON.stringify(last_poll_response) : null,
      metadata_url || null,
      error_message || null,
      Number(id)
    );
  },

  remove(id) {
    return stmts.deleteTask.run(Number(id)).changes > 0;
  },

  clearCompleted() {
    return Number(stmts.clearCompleted.run().changes);
  },

  clearAll() {
    return Number(stmts.clearAll.run().changes);
  },
};

/** 默认设置（与文档对齐） */
const DEFAULT_SETTINGS = {
  base_url: 'https://apihub.agnes-ai.com',
  model: 'agnes-video-2.5-flash',
  poll_interval_ms: '2000',
  max_active_minutes: '20',
};

module.exports = { db, settings, tasks, DEFAULT_SETTINGS, DB_PATH, DATA_DIR };