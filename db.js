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
  ['project_id', 'INTEGER'],    // 流水线项目关联（M1）
  ['shot_id', 'INTEGER'],       // 镜头溯源（M2）
  ['text_id', 'INTEGER'],       // 提示词文本版本溯源（M2）
  ['image_id', 'INTEGER'],      // 引用图片溯源（M2）
];
for (const [name, type] of MIGRATE_COLS) {
  if (!existingCols.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
}
// M2 溯源索引（列由上方迁移补齐后再建，避免旧库启动失败）
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_shot ON tasks(shot_id)');

const stmts = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  insertTask: db.prepare(`
    INSERT INTO tasks (status, mode, model, prompt, seconds, size, aspect_ratio, seed,
                       first_frame, last_frame, images, audios, videos, request_json,
                       image, num_frames, frame_rate, width, height, negative_prompt, project_id,
                       shot_id, text_id, image_id,
                       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  listTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR prompt LIKE ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `),
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
      image = ?, num_frames = ?, frame_rate = ?, width = ?, height = ?, negative_prompt = ?,
      project_id = ?, shot_id = ?, text_id = ?, image_id = ?
    WHERE id = ?
  `),
  insertProject: db.prepare(`
    INSERT INTO projects (name, idea, style, aspect_ratio, seconds, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
  listProjects: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC'),
  updateProject: db.prepare(`
    UPDATE projects SET name = ?, idea = ?, style = ?, aspect_ratio = ?, seconds = ?, status = ?, updated_at = ?
    WHERE id = ?
  `),
  deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
  deleteProjectTexts: db.prepare('DELETE FROM project_texts WHERE project_id = ?'),
  deleteProjectImages: db.prepare('DELETE FROM project_images WHERE project_id = ?'),
  detachProjectTasks: db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?'),
  insertProjectText: db.prepare(`
    INSERT INTO project_texts (project_id, kind, content, model, selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listProjectTexts: db.prepare('SELECT * FROM project_texts WHERE project_id = ? ORDER BY created_at DESC, id DESC'),
  unselectProjectTexts: db.prepare('UPDATE project_texts SET selected = 0 WHERE project_id = ? AND kind = ? AND id != ?'),
  selectProjectText: db.prepare('UPDATE project_texts SET selected = 1 WHERE id = ?'),
  updateProjectText: db.prepare('UPDATE project_texts SET content = ? WHERE id = ?'),
  insertProjectImage: db.prepare(`
    INSERT INTO project_images (project_id, kind, prompt, remote_url, local_path, size, ratio, model, selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listProjectImages: db.prepare('SELECT * FROM project_images WHERE project_id = ? ORDER BY created_at DESC, id DESC'),
  unselectProjectImages: db.prepare('UPDATE project_images SET selected = 0 WHERE project_id = ? AND kind = ? AND id != ?'),
  selectProjectImage: db.prepare('UPDATE project_images SET selected = 1 WHERE id = ?'),
  deleteProjectImage: db.prepare('DELETE FROM project_images WHERE id = ?'),
  getSelectedProjectImage: db.prepare(
    "SELECT * FROM project_images WHERE project_id = ? AND kind = ? AND selected = 1 ORDER BY id DESC LIMIT 1"
  ),
  getSelectedProjectText: db.prepare(
    "SELECT * FROM project_texts WHERE project_id = ? AND kind = ? AND selected = 1 ORDER BY id DESC LIMIT 1"
  ),
  listProjectTasks: db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC, id DESC'),
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

  /* M2：镜头 */
  insertShot: db.prepare(`
    INSERT INTO shots (project_id, seq, title, video_prompt, seconds, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getShot: db.prepare('SELECT * FROM shots WHERE id = ?'),
  listShots: db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY seq ASC, id ASC'),
  updateShotFull: db.prepare('UPDATE shots SET seq = ?, title = ?, video_prompt = ?, seconds = ?, mode = ?, updated_at = ? WHERE id = ?'),
  updateShotSeq: db.prepare('UPDATE shots SET seq = ?, updated_at = ? WHERE id = ? AND project_id = ?'),
  deleteShot: db.prepare('DELETE FROM shots WHERE id = ?'),
  deleteShotsByProject: db.prepare('DELETE FROM shots WHERE project_id = ?'),
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

/** 多步写事务：任一步失败自动回滚（node:sqlite 同步连接，事务只为保证多语句原子性） */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
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
    project_id: row.project_id === null ? null : Number(row.project_id),
    shot_id: row.shot_id === null ? null : Number(row.shot_id),
    text_id: row.text_id === null ? null : Number(row.text_id),
    image_id: row.image_id === null ? null : Number(row.image_id),
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
           image, num_frames, frame_rate, width, height, negative_prompt, project_id,
           shot_id, text_id, image_id }) {
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
      project_id || null,
      shot_id || null,
      text_id || null,
      image_id || null,
      now, now
    );
    return Number(r.lastInsertRowid);
  },

  get(id) {
    return toTaskRow(stmts.getTask.get(Number(id)));
  },

  list({ status = null, q = null, limit = 100, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const qp = q ? `%${q}%` : null;
    // 注意：SQL 有 6 个占位符（状态×2 + 搜索×2 + LIMIT + OFFSET），必须绑定 6 个参数
    return stmts.listTasks.all(status, status, qp, qp, lim, off).map(toTaskRow);
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
      p.project_id !== undefined ? p.project_id : cur.project_id,
      p.shot_id !== undefined ? p.shot_id : cur.shot_id,
      p.text_id !== undefined ? p.text_id : cur.text_id,
      p.image_id !== undefined ? p.image_id : cur.image_id,
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
};

/** 默认设置（与文档对齐） */
const DEFAULT_SETTINGS = {
  base_url: 'https://apihub.agnes-ai.com',
  model: 'agnes-video-2.5-flash',
  poll_interval_ms: '2000',
  max_active_minutes: '20',
  submit_interval_ms: '60000', // M2：批量分镜提交间隔（0 = 连续提交）
};

/* ---------------- 创作流水线（projects / texts / images） ---------------- */

function projectRowToApi(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    idea: row.idea,
    style: row.style,
    aspect_ratio: row.aspect_ratio,
    seconds: row.seconds,
    status: row.status,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function shotRowToApi(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    seq: Number(row.seq || 0),
    title: row.title,
    video_prompt: row.video_prompt,
    seconds: row.seconds,
    mode: row.mode || 'reference',
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const projects = {
  insert({ name, idea, style, aspect_ratio, seconds }) {
    const now = Date.now();
    const r = stmts.insertProject.run(
      name, idea || null, style || null, aspect_ratio || '16:9', seconds || '5', 'draft', now, now
    );
    return Number(r.lastInsertRowid);
  },

  get(id) {
    return projectRowToApi(stmts.getProject.get(Number(id)));
  },

  list() {
    return stmts.listProjects.all().map(projectRowToApi);
  },

  update(id, patch = {}) {
    const cur = stmts.getProject.get(Number(id));
    if (!cur) return false;
    stmts.updateProject.run(
      patch.name !== undefined ? patch.name : cur.name,
      patch.idea !== undefined ? patch.idea : cur.idea,
      patch.style !== undefined ? patch.style : cur.style,
      patch.aspect_ratio !== undefined ? patch.aspect_ratio : cur.aspect_ratio,
      patch.seconds !== undefined ? patch.seconds : cur.seconds,
      patch.status !== undefined ? patch.status : cur.status,
      Date.now(),
      Number(id)
    );
    return true;
  },

  remove(id) {
    // 级联清理：文案、图片、镜头；视频任务保留但解除关联（事务保证原子完成）
    return tx(() => {
      stmts.deleteProjectTexts.run(Number(id));
      stmts.deleteProjectImages.run(Number(id));
      stmts.deleteShotsByProject.run(Number(id));
      stmts.detachProjectTasks.run(Number(id));
      return stmts.deleteProject.run(Number(id)).changes > 0;
    });
  },

  texts(projectId) {
    return stmts.listProjectTexts.all(Number(projectId)).map((r) => ({
      id: Number(r.id), project_id: Number(r.project_id), kind: r.kind,
      content: r.content, model: r.model, selected: Boolean(r.selected),
      created_at: Number(r.created_at),
    }));
  },

  addText({ project_id, kind, content, model }) {
    const r = stmts.insertProjectText.run(Number(project_id), kind, content, model || null, 0, Date.now());
    return Number(r.lastInsertRowid);
  },

  selectText(id, kind, projectId) {
    tx(() => {
      stmts.unselectProjectTexts.run(Number(projectId), kind, Number(id));
      stmts.selectProjectText.run(Number(id));
    });
  },

  selectedText(projectId, kind) {
    const row = stmts.getSelectedProjectText.get(Number(projectId), kind);
    if (!row) return null;
    return { id: Number(row.id), project_id: Number(row.project_id), kind: row.kind,
             content: row.content, model: row.model, selected: true, created_at: Number(row.created_at) };
  },

  images(projectId) {
    return stmts.listProjectImages.all(Number(projectId)).map((r) => ({
      id: Number(r.id), project_id: Number(r.project_id), kind: r.kind, prompt: r.prompt,
      remote_url: r.remote_url, local_path: r.local_path,
      local_url: r.local_path ? '/artifacts/' + path.basename(r.local_path) : null,
      size: r.size, ratio: r.ratio,
      model: r.model, selected: Boolean(r.selected), created_at: Number(r.created_at),
    }));
  },

  addImage({ project_id, kind, prompt, remote_url, local_path, size, ratio, model }) {
    const r = stmts.insertProjectImage.run(
      Number(project_id), kind, prompt || null, remote_url || null, local_path || null,
      size || null, ratio || null, model || null, 0, Date.now()
    );
    return Number(r.lastInsertRowid);
  },

  selectImage(id, kind, projectId) {
    tx(() => {
      stmts.unselectProjectImages.run(Number(projectId), kind, Number(id));
      stmts.selectProjectImage.run(Number(id));
    });
  },

  selectedImage(projectId, kind) {
    const row = stmts.getSelectedProjectImage.get(Number(projectId), kind);
    if (!row) return null;
    return {
      id: Number(row.id), project_id: Number(row.project_id), kind: row.kind, prompt: row.prompt,
      remote_url: row.remote_url, local_path: row.local_path, size: row.size, ratio: row.ratio,
      model: row.model, selected: true, created_at: Number(row.created_at),
    };
  },

  removeImage(id) {
    return stmts.deleteProjectImage.run(Number(id)).changes > 0;
  },

  updateText(id, content) {
    return stmts.updateProjectText.run(content, Number(id)).changes > 0;
  },

  tasks(projectId) {
    return stmts.listProjectTasks.all(Number(projectId)).map(toTaskRow);
  },

  /* ---------------- M2：镜头（分镜工作副本） ---------------- */

  shots(projectId) {
    return stmts.listShots.all(Number(projectId)).map(shotRowToApi);
  },

  addShot({ project_id, seq, title, video_prompt, seconds, mode }) {
    const now = Date.now();
    const r = stmts.insertShot.run(
      Number(project_id), Number(seq) || 0, title || null, video_prompt || '',
      seconds || null, mode || 'reference', now, now
    );
    return Number(r.lastInsertRowid);
  },

  updateShot(id, patch = {}) {
    const cur = stmts.getShot.get(Number(id));
    if (!cur) return false;
    stmts.updateShotFull.run(
      patch.seq !== undefined ? Number(patch.seq) : cur.seq,
      patch.title !== undefined ? patch.title : cur.title,
      patch.video_prompt !== undefined ? patch.video_prompt : cur.video_prompt,
      patch.seconds !== undefined ? patch.seconds : cur.seconds,
      patch.mode !== undefined ? patch.mode : cur.mode,
      Date.now(),
      Number(id)
    );
    return true;
  },

  removeShot(id) {
    return stmts.deleteShot.run(Number(id)).changes > 0;
  },

  /** 用分镜脚本整体替换项目的镜头工作副本（事务：先清后插），返回新镜头 id 列表 */
  replaceShots(projectId, shotsArr) {
    const pid = Number(projectId);
    return tx(() => {
      stmts.deleteShotsByProject.run(pid);
      const now = Date.now();
      return shotsArr.map((s, i) =>
        Number(stmts.insertShot.run(
          pid, Number(s.seq ?? (i + 1)) || (i + 1), s.title || null, s.video_prompt || '',
          s.seconds || null, s.mode || 'reference', now, now
        ).lastInsertRowid)
      );
    });
  },

  /** 按 ids 顺序重排镜头 seq（事务；调用方需先校验 ids 合法性） */
  reorderShots(projectId, ids) {
    const pid = Number(projectId);
    return tx(() => {
      ids.forEach((id, i) => {
        stmts.updateShotSeq.run(i + 1, Date.now(), Number(id), pid);
      });
      return true;
    });
  },
};

module.exports = { db, settings, tasks, projects, tx, DEFAULT_SETTINGS, DB_PATH, DATA_DIR };