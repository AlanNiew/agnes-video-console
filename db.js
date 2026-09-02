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

const stmts = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ),
  insertTask: db.prepare(`
    INSERT INTO tasks (status, kind, mode, model, prompt, seconds, size, aspect_ratio, seed,
                       first_frame, last_frame, images, audios, videos, request_json,
                       image, num_frames, frame_rate, width, height, negative_prompt, project_id,
                       shot_id, text_id, image_id,
                       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getTask: db.prepare(`
    SELECT t.*, p.name AS project_name, s.seq AS shot_seq, s.title AS shot_title, pi.kind AS image_kind
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN shots s ON s.id = t.shot_id
    LEFT JOIN project_images pi ON pi.id = t.image_id
    WHERE t.id = ?
  `),
  listTasks: db.prepare(`
    SELECT t.*, p.name AS project_name, s.seq AS shot_seq, s.title AS shot_title, pi.kind AS image_kind
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN shots s ON s.id = t.shot_id
    LEFT JOIN project_images pi ON pi.id = t.image_id
    WHERE (? IS NULL OR t.status = ?)
      AND (? IS NULL OR t.prompt LIKE ?)
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `),
  // P0 分页：与 listTasks 同条件的总数统计（供任务中心翻页）
  countTasksFiltered: db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR prompt LIKE ?)
  `),
  activeTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('queued','in_progress') AND video_id IS NOT NULL AND video_id != ''
    ORDER BY created_at ASC
  `),
  // v1.3 提交队列：待提交任务（提交器接管后不再按 created_at 年龄过滤）；
  // P1 起排除图片任务（kind='image' 由 image-worker 接管，存量 NULL 视为 video）
  pendingSubmitTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'queued' AND (video_id IS NULL OR video_id = '')
      AND (kind IS NULL OR kind = 'video')
    ORDER BY created_at ASC, id ASC
  `),
  // P1：待生成图片任务（image worker 接管）
  pendingImageTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE kind = 'image' AND status = 'queued'
    ORDER BY created_at ASC, id ASC
  `),
  // v1.3 视频归档补扫：已完成但未本地归档的任务
  completedWithoutLocal: db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'completed' AND metadata_url IS NOT NULL AND metadata_url != ''
      AND (video_local_path IS NULL OR video_local_path = '')
    ORDER BY id ASC
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
      project_id = ?, shot_id = ?, text_id = ?, image_id = ?,
      submitted_at = ?, video_local_path = ?, retry_count = ?
    WHERE id = ?
  `),
  // v2.1 原任务重试：失败任务原地重置为 queued（清空上次执行结果，保留输入参数与溯源；
  // 图片任务 kind='image' 时清空 images 产物列，视频任务的参考素材 images/audios/videos 列不动）
  retryTask: db.prepare(`
    UPDATE tasks SET
      status = 'queued', task_id = NULL, video_id = NULL, progress = 0,
      updated_at = ?, completed_at = NULL, submit_response = NULL, last_poll_response = NULL,
      metadata_url = NULL, error_message = NULL, poll_count = 0, last_polled_at = NULL,
      submitted_at = NULL, video_local_path = NULL,
      images = CASE WHEN kind = 'image' THEN '[]' ELSE images END,
      retry_count = COALESCE(retry_count, 0) + 1
    WHERE id = ? AND status IN ('failed', 'submit_error')
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
  setProjectBgm: db.prepare('UPDATE projects SET bgm = ?, updated_at = ? WHERE id = ?'),
  deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
  deleteProjectTexts: db.prepare('DELETE FROM project_texts WHERE project_id = ?'),
  deleteProjectImages: db.prepare('DELETE FROM project_images WHERE project_id = ?'),
  detachProjectTasks: db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?'),
  insertProjectText: db.prepare(`
    INSERT INTO project_texts (project_id, kind, content, model, selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listProjectTexts: db.prepare('SELECT * FROM project_texts WHERE project_id = ? ORDER BY created_at DESC, id DESC'),
  unselectProjectTexts: db.prepare(
    'UPDATE project_texts SET selected = 0 WHERE project_id = ? AND kind = ? AND id != ?',
  ),
  selectProjectText: db.prepare('UPDATE project_texts SET selected = 1 WHERE id = ?'),
  updateProjectText: db.prepare('UPDATE project_texts SET content = ? WHERE id = ?'),
  insertProjectImage: db.prepare(`
    INSERT INTO project_images (project_id, kind, prompt, remote_url, local_path, size, ratio, model, selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listProjectImages: db.prepare('SELECT * FROM project_images WHERE project_id = ? ORDER BY created_at DESC, id DESC'),
  unselectProjectImages: db.prepare(
    'UPDATE project_images SET selected = 0 WHERE project_id = ? AND kind = ? AND id != ?',
  ),
  selectProjectImage: db.prepare('UPDATE project_images SET selected = 1 WHERE id = ?'),
  deleteProjectImage: db.prepare('DELETE FROM project_images WHERE id = ?'),
  getSelectedProjectImage: db.prepare(
    'SELECT * FROM project_images WHERE project_id = ? AND kind = ? AND selected = 1 ORDER BY id DESC LIMIT 1',
  ),
  getSelectedProjectText: db.prepare(
    'SELECT * FROM project_texts WHERE project_id = ? AND kind = ? AND selected = 1 ORDER BY id DESC LIMIT 1',
  ),
  listProjectTasks: db.prepare(`
    SELECT t.*, p.name AS project_name, s.seq AS shot_seq, s.title AS shot_title, pi.kind AS image_kind
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN shots s ON s.id = t.shot_id
    LEFT JOIN project_images pi ON pi.id = t.image_id
    WHERE t.project_id = ?
    ORDER BY t.created_at DESC, t.id DESC
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

  /* M2：镜头 */
  insertShot: db.prepare(`
    INSERT INTO shots (project_id, seq, title, video_prompt, seconds, mode, narration, use_character_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getShot: db.prepare('SELECT * FROM shots WHERE id = ?'),
  listShots: db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY seq ASC, id ASC'),
  updateShotFull: db.prepare(
    'UPDATE shots SET seq = ?, title = ?, video_prompt = ?, seconds = ?, mode = ?, narration = ?, use_character_ref = ?, updated_at = ? WHERE id = ?',
  ),
  updateShotSeq: db.prepare('UPDATE shots SET seq = ?, updated_at = ? WHERE id = ? AND project_id = ?'),
  deleteShot: db.prepare('DELETE FROM shots WHERE id = ?'),
  deleteShotsByProject: db.prepare('DELETE FROM shots WHERE project_id = ?'),

  /* TTS：配音记录 */
  insertTts: db.prepare(`
    INSERT INTO project_tts (project_id, kind, shot_id, text, model, reference_id, voice_title, format,
                             local_path, duration, size, error_message, selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listProjectTts: db.prepare('SELECT * FROM project_tts WHERE project_id = ? ORDER BY created_at DESC, id DESC'),
  getTts: db.prepare('SELECT * FROM project_tts WHERE id = ?'),
  unselectProjectTts: db.prepare('UPDATE project_tts SET selected = 0 WHERE project_id = ? AND id != ?'),
  selectTts: db.prepare('UPDATE project_tts SET selected = 1 WHERE id = ?'),
  bindTts: db.prepare('UPDATE project_tts SET kind = ?, shot_id = ? WHERE id = ?'),
  setShotTake: db.prepare('UPDATE shots SET take_task_id = ?, updated_at = ? WHERE id = ?'),
  clearShotTakeByTask: db.prepare('UPDATE shots SET take_task_id = NULL, updated_at = ? WHERE take_task_id = ?'),
  deleteTts: db.prepare('DELETE FROM project_tts WHERE id = ?'),
  deleteTtsByProject: db.prepare('DELETE FROM project_tts WHERE project_id = ?'),

  /* v1.3：成片渲染任务 */
  insertRenderJob: db.prepare(
    'INSERT INTO render_jobs (project_id, status, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ),
  getRenderJob: db.prepare('SELECT * FROM render_jobs WHERE id = ?'),
  listRenderJobsByProject: db.prepare('SELECT * FROM render_jobs WHERE project_id = ? ORDER BY id DESC'),
  queuedRenderJobs: db.prepare("SELECT * FROM render_jobs WHERE status = 'queued' ORDER BY id ASC"),
  // v1.9.2 渲染自愈：进程崩溃/退出遗留的 rendering 任务复位回 queued（启动时由渲染器调用）
  resetStuckRenderJobs: db.prepare("UPDATE render_jobs SET status = 'queued', progress = 0 WHERE status = 'rendering'"),
  updateRenderJob: db.prepare(
    'UPDATE render_jobs SET status = ?, progress = ?, output_path = ?, error_message = ?, covers = ?, quality = ?, work_dir = ?, updated_at = ? WHERE id = ?',
  ),
  // P3：全自动成片状态机（auto.js 持有；JSON 落 projects.auto_state）
  setProjectAutoState: db.prepare('UPDATE projects SET auto_state = ?, updated_at = ? WHERE id = ?'),
  deleteRenderJob: db.prepare('DELETE FROM render_jobs WHERE id = ?'),
  deleteRenderJobsByProject: db.prepare('DELETE FROM render_jobs WHERE project_id = ?'),
  // v1.9.2 单实例锁原子 CAS（upsert 形式）：
  // 首次插入必成功；行已存在时仅当「锁属本进程 / 心跳过期 / 坏数据」才覆盖——
  // 单条语句的语句级写锁保证跨进程原子性（tx/BEGIN IMMEDIATE 在 node:sqlite
  // 跨进程实测不产生互斥，两进程可同时通过检查各自写入，故弃用）。
  // CASE 逐分支惰性求值：json_valid 守卫在前，坏 JSON 不会触达 json_extract 抛错。
  casInstanceLock: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CASE
      WHEN json_valid(settings.value) = 0 THEN 1
      WHEN CAST(json_extract(settings.value, '$.pid') AS INTEGER) = ? THEN 1
      WHEN json_extract(settings.value, '$.heartbeat') IS NULL THEN 1
      WHEN CAST(json_extract(settings.value, '$.heartbeat') AS INTEGER) < ? THEN 1
      ELSE 0
    END = 1
  `),
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
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** 将数据库行转换为对前端友好的任务对象 */
function toTaskRow(row) {
  if (!row) return null;
  const out = {
    id: Number(row.id),
    kind: row.kind === 'image' ? 'image' : 'video',
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
    submitted_at: row.submitted_at === null || row.submitted_at === undefined ? null : Number(row.submitted_at),
    video_local_path: row.video_local_path,
    video_local_url: row.video_local_path ? '/artifacts/' + path.basename(row.video_local_path) : null,
    retry_count: Number(row.retry_count || 0),
  };
  // v2.1 来源上下文（列表/看板/详情直接展示，不用前端再查）：项目名 / 镜头序号与标题 / 引用图片类型。
  // image_kind 兜底链：JOIN project_images（完成回写的 image_id）→ request_json.image_kind（入队时的用途标记）
  const reqJson = out.request_json;
  out.project_name = row.project_name === undefined ? null : row.project_name;
  out.shot_seq = row.shot_seq === undefined || row.shot_seq === null ? null : Number(row.shot_seq);
  out.shot_title = row.shot_title === undefined ? null : row.shot_title;
  out.image_kind =
    row.image_kind === undefined || row.image_kind === null
      ? reqJson && ['character', 'scene'].includes(reqJson.image_kind)
        ? reqJson.image_kind
        : null
      : row.image_kind;
  return out;
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
  insert({
    kind,
    status,
    mode,
    model,
    prompt,
    seconds,
    size,
    aspect_ratio,
    seed,
    first_frame,
    last_frame,
    images,
    audios,
    videos,
    request_json,
    image,
    num_frames,
    frame_rate,
    width,
    height,
    negative_prompt,
    project_id,
    shot_id,
    text_id,
    image_id,
  }) {
    const now = Date.now();
    const r = stmts.insertTask.run(
      status,
      kind || 'video',
      mode || 'text',
      model || 'agnes-video-2.5-flash',
      prompt || '',
      seconds ?? null, // 可空字段归一化：undefined 无法绑定 SQLite 参数（图片任务无 seconds）
      size ?? null,
      aspect_ratio ?? null,
      seed === null || seed === undefined ? null : Number(seed),
      first_frame || null,
      last_frame || null,
      JSON.stringify(images || []),
      JSON.stringify(audios || []),
      JSON.stringify(videos || []),
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
      now,
      now,
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

  /** P0：分页查询（列表 + 满足筛选的总数），供任务中心翻页 */
  page({ status = null, q = null, limit = 100, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const qp = q ? `%${q}%` : null;
    const items = stmts.listTasks.all(status, status, qp, qp, lim, off).map(toTaskRow);
    const total = Number(stmts.countTasksFiltered.get(status, status, qp, qp).n);
    return { items, total };
  },

  active() {
    return stmts.activeTasks.all().map(toTaskRow);
  },

  /** v1.3 提交队列：待提交任务（queued 且尚未获得 video_id），由 submitter 接管 */
  pendingSubmit() {
    return stmts.pendingSubmitTasks.all().map(toTaskRow);
  },

  /** P1：待生成图片任务，由 image worker 接管 */
  pendingImages() {
    return stmts.pendingImageTasks.all().map(toTaskRow);
  },

  /** v1.3 归档补扫：已完成但尚未本地归档的任务 */
  completedWithoutLocal() {
    return stmts.completedWithoutLocal.all().map(toTaskRow);
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
      p.submit_response !== undefined ? JSON.stringify(p.submit_response) : cur.submit_response,
      p.last_poll_response !== undefined ? JSON.stringify(p.last_poll_response) : cur.last_poll_response,
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
      p.submitted_at !== undefined ? p.submitted_at : cur.submitted_at,
      p.video_local_path !== undefined ? p.video_local_path : cur.video_local_path,
      p.retry_count !== undefined ? p.retry_count : cur.retry_count,
      Number(id),
    );
    return true;
  },

  /** v2.1：失败任务原地重试（重置为 queued 并清空上次执行结果；仅 failed/submit_error 可重试）。
   * 返回重试后的任务行；状态不符返回 null。retry_count 由 SQL 自增。 */
  retry(id) {
    const changed = stmts.retryTask.run(Date.now(), Number(id)).changes > 0;
    if (!changed) return null;
    return this.get(id);
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
      Number(id),
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
const { DEFAULT_BASE_URL } = require('./config');

const DEFAULT_SETTINGS = {
  base_url: DEFAULT_BASE_URL,
  model: 'agnes-video-2.5-flash',
  poll_interval_ms: '2000',
  max_active_minutes: '20',
  submit_interval_ms: '60000', // M2：批量分镜提交间隔（0 = 连续提交）
  fish_api_key: '', // TTS：Fish Audio API Key（可选；不配置则配音功能不可用）
  fish_voice: 'default', // TTS：默认音色（default = 平台默认；或 Fish 音色库模型 id）
  fish_speed: '1', // TTS：默认语速 0.5–2.0
  music_api_base: '', // v1.4 BGM：音乐接口地址（如 http://60.204.147.98:15001；留空则 BGM 功能不可用）
  music_api_token: '', // v1.4 BGM：音乐接口 Token（Authorization 头，仅服务端使用）
  music_level: 'exhigh', // v1.4 BGM：默认音质 standard/exhigh/lossless/hires
  fish_web_token: '', // v1.9 声音广场：fish.audio 网页端 Token（浏览社区音色；仅服务端使用）
  tts_voice_pool: '[]', // v1.9 音色备选池（JSON 数组：从声音广场收录的真实音色）
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
    bgm: parseJson(row.bgm), // v1.4：项目背景音乐选择
    auto_state: parseJson(row.auto_state) || null, // P3：全自动成片状态机
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
    narration: row.narration,
    seconds: row.seconds,
    mode: row.mode || 'reference',
    use_character_ref:
      row.use_character_ref === null || row.use_character_ref === undefined ? 1 : Number(row.use_character_ref),
    take_task_id: row.take_task_id === null || row.take_task_id === undefined ? null : Number(row.take_task_id), // v1.7 重拍定稿
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const projects = {
  insert({ name, idea, style, aspect_ratio, seconds }) {
    const now = Date.now();
    const r = stmts.insertProject.run(
      name,
      idea || null,
      style || null,
      aspect_ratio || '16:9',
      seconds || '5',
      'draft',
      now,
      now,
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
      Number(id),
    );
    return true;
  },

  /** v1.4：设置/清除项目背景音乐选择（bgmJson 为对象或 null） */
  setBgm(id, bgmJson) {
    const cur = stmts.getProject.get(Number(id));
    if (!cur) return false;
    stmts.setProjectBgm.run(bgmJson ? JSON.stringify(bgmJson) : null, Date.now(), Number(id));
    return true;
  },

  /** P3：写入全自动成片状态机（stateJson 为对象或 null 清除） */
  setAutoState(id, stateJson) {
    const cur = stmts.getProject.get(Number(id));
    if (!cur) return false;
    stmts.setProjectAutoState.run(stateJson ? JSON.stringify(stateJson) : null, Date.now(), Number(id));
    return true;
  },

  remove(id) {
    // 级联清理：文案、图片、镜头、配音、渲染任务；视频任务保留但解除关联（事务保证原子完成）
    return tx(() => {
      stmts.deleteProjectTexts.run(Number(id));
      stmts.deleteProjectImages.run(Number(id));
      stmts.deleteTtsByProject.run(Number(id));
      stmts.deleteShotsByProject.run(Number(id));
      stmts.deleteRenderJobsByProject.run(Number(id));
      stmts.detachProjectTasks.run(Number(id));
      return stmts.deleteProject.run(Number(id)).changes > 0;
    });
  },

  texts(projectId) {
    return stmts.listProjectTexts.all(Number(projectId)).map((r) => ({
      id: Number(r.id),
      project_id: Number(r.project_id),
      kind: r.kind,
      content: r.content,
      model: r.model,
      selected: Boolean(r.selected),
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
    return {
      id: Number(row.id),
      project_id: Number(row.project_id),
      kind: row.kind,
      content: row.content,
      model: row.model,
      selected: true,
      created_at: Number(row.created_at),
    };
  },

  images(projectId) {
    return stmts.listProjectImages.all(Number(projectId)).map((r) => ({
      id: Number(r.id),
      project_id: Number(r.project_id),
      kind: r.kind,
      prompt: r.prompt,
      remote_url: r.remote_url,
      local_path: r.local_path,
      local_url: r.local_path ? '/artifacts/' + path.basename(r.local_path) : null,
      size: r.size,
      ratio: r.ratio,
      model: r.model,
      selected: Boolean(r.selected),
      created_at: Number(r.created_at),
    }));
  },

  addImage({ project_id, kind, prompt, remote_url, local_path, size, ratio, model }) {
    const r = stmts.insertProjectImage.run(
      Number(project_id),
      kind,
      prompt || null,
      remote_url || null,
      local_path || null,
      size || null,
      ratio || null,
      model || null,
      0,
      Date.now(),
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
      id: Number(row.id),
      project_id: Number(row.project_id),
      kind: row.kind,
      prompt: row.prompt,
      remote_url: row.remote_url,
      local_path: row.local_path,
      size: row.size,
      ratio: row.ratio,
      model: row.model,
      selected: true,
      created_at: Number(row.created_at),
    };
  },

  removeImage(id) {
    return stmts.deleteProjectImage.run(Number(id)).changes > 0;
  },

  updateText(id, content) {
    return stmts.updateProjectText.run(content, Number(id)).changes > 0;
  },

  tasks(projectId) {
    const rows = stmts.listProjectTasks.all(Number(projectId)).map(toTaskRow);
    // v1.3 superseded 计算（仅响应层，不改库）：同镜头已有 completed 任务时，
    // 更早的 failed/submit_error 记录视为「已被新任务取代」，避免看板被废记录误导
    const okShots = new Set(rows.filter((t) => t.status === 'completed' && t.shot_id).map((t) => t.shot_id));
    for (const t of rows) {
      if (t.shot_id && okShots.has(t.shot_id) && (t.status === 'failed' || t.status === 'submit_error')) {
        t.superseded = true;
      }
    }
    return rows;
  },

  /* ---------------- M2：镜头（分镜工作副本） ---------------- */

  shots(projectId) {
    return stmts.listShots.all(Number(projectId)).map(shotRowToApi);
  },

  addShot({ project_id, seq, title, video_prompt, seconds, mode, narration, use_character_ref }) {
    const now = Date.now();
    const r = stmts.insertShot.run(
      Number(project_id),
      Number(seq) || 0,
      title || null,
      video_prompt || '',
      seconds || null,
      mode || 'reference',
      narration || null,
      use_character_ref === undefined || use_character_ref === null ? 1 : use_character_ref ? 1 : 0,
      now,
      now,
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
      patch.narration !== undefined
        ? String(patch.narration || '')
            .trim()
            .slice(0, 200) || null
        : cur.narration,
      patch.use_character_ref !== undefined ? (patch.use_character_ref ? 1 : 0) : cur.use_character_ref,
      Date.now(),
      Number(id),
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
        Number(
          stmts.insertShot.run(
            pid,
            Number(s.seq ?? i + 1) || i + 1,
            s.title || null,
            s.video_prompt || '',
            s.seconds || null,
            s.mode || 'reference',
            s.narration || null,
            s.use_character_ref === undefined || s.use_character_ref === null ? 1 : s.use_character_ref ? 1 : 0,
            now,
            now,
          ).lastInsertRowid,
        ),
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

  /* ---------------- TTS：配音记录 ---------------- */

  tts(projectId) {
    return stmts.listProjectTts.all(Number(projectId)).map(ttsRowToApi);
  },

  addTts({
    project_id,
    kind,
    shot_id,
    text,
    model,
    reference_id,
    voice_title,
    format,
    local_path,
    duration,
    size,
    error_message,
    selected,
  }) {
    const r = stmts.insertTts.run(
      Number(project_id),
      kind || 'narration',
      shot_id === undefined || shot_id === null ? null : Number(shot_id),
      String(text || ''),
      model || 's2.1-pro-free',
      reference_id || null,
      voice_title || null,
      format || 'mp3',
      local_path || null,
      duration === undefined || duration === null ? null : Number(duration),
      size === undefined || size === null ? null : Number(size),
      error_message || null,
      selected ? 1 : 0,
      Date.now(),
    );
    return Number(r.lastInsertRowid);
  },

  getTts(id) {
    return ttsRowToApi(stmts.getTts.get(Number(id)));
  },

  selectTts(id, projectId) {
    tx(() => {
      stmts.unselectProjectTts.run(Number(projectId), Number(id));
      stmts.selectTts.run(Number(id));
    });
  },

  /** v1.5：绑定/解绑旁白到镜头（kind: 'shot'|'narration'，shotId 绑定时必填） */
  bindTts(id, kind, shotId) {
    return (
      stmts.bindTts.run(
        kind || 'narration',
        shotId === undefined || shotId === null ? null : Number(shotId),
        Number(id),
      ).changes > 0
    );
  },

  /** v1.7：镜头选定重拍定稿 take（taskId=null 恢复自动模式：用最新完成条） */
  setShotTake(id, taskId) {
    return (
      stmts.setShotTake.run(taskId === undefined || taskId === null ? null : Number(taskId), Date.now(), Number(id))
        .changes > 0
    );
  },

  /** v1.7：任务被删除时，清掉引用它的镜头定稿（回退自动模式） */
  clearShotTakeByTask(taskId) {
    return stmts.clearShotTakeByTask.run(Date.now(), Number(taskId)).changes > 0;
  },

  removeTts(id) {
    const row = stmts.getTts.get(Number(id));
    if (!row) return false;
    const removed = stmts.deleteTts.run(Number(id)).changes > 0;
    // 尽力删除本地音频文件（失败不阻塞）
    if (removed && row.local_path) {
      try {
        fs.rmSync(row.local_path, { force: true });
      } catch {
        /* ignore */
      }
    }
    return removed;
  },
};

function ttsRowToApi(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    kind: row.kind || 'narration',
    shot_id: row.shot_id === null || row.shot_id === undefined ? null : Number(row.shot_id),
    text: row.text,
    model: row.model,
    reference_id: row.reference_id,
    voice_title: row.voice_title,
    format: row.format || 'mp3',
    local_path: row.local_path,
    local_url: row.local_path ? '/artifacts/' + path.basename(row.local_path) : null,
    duration: row.duration === null || row.duration === undefined ? null : Number(row.duration),
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    error_message: row.error_message,
    selected: Boolean(row.selected),
    created_at: Number(row.created_at),
  };
}

/* ---------------- v1.3：成片渲染任务 ---------------- */

function renderRowToApi(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    status: row.status,
    params: parseJson(row.params) || {},
    progress: Number(row.progress || 0),
    output_path: row.output_path,
    output_url: row.output_path ? '/artifacts/' + path.basename(row.output_path) : null,
    covers: parseJson(row.covers) || [], // v1.8 封面候选 [{path,url}]
    quality: parseJson(row.quality) || null, // P3：质检报告 {duration_s, expected_duration_s, loudness_lufs, shots, narrated_shots, sub_lines}
    work_dir: row.work_dir || null, // v2.2：作品归档目录（data/works/《名》-id，含成片/字幕/台词/海报）
    work_url: row.work_dir ? '/works/' + encodeURIComponent(path.basename(row.work_dir)) : null,
    error_message: row.error_message,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const renders = {
  insert({ project_id, params }) {
    const now = Date.now();
    const r = stmts.insertRenderJob.run(Number(project_id), 'queued', JSON.stringify(params || {}), now, now);
    return Number(r.lastInsertRowid);
  },
  get(id) {
    return renderRowToApi(stmts.getRenderJob.get(Number(id)));
  },
  listByProject(projectId) {
    return stmts.listRenderJobsByProject.all(Number(projectId)).map(renderRowToApi);
  },
  queued() {
    return stmts.queuedRenderJobs.all().map(renderRowToApi);
  },
  update(id, patch = {}) {
    const cur = stmts.getRenderJob.get(Number(id));
    if (!cur) return false;
    stmts.updateRenderJob.run(
      patch.status !== undefined ? patch.status : cur.status,
      patch.progress !== undefined ? Number(patch.progress) : cur.progress,
      patch.output_path !== undefined ? patch.output_path : cur.output_path,
      patch.error_message !== undefined ? patch.error_message : cur.error_message,
      patch.covers !== undefined ? JSON.stringify(patch.covers) : cur.covers,
      patch.quality !== undefined ? JSON.stringify(patch.quality) : cur.quality,
      patch.work_dir !== undefined ? patch.work_dir : cur.work_dir,
      Date.now(),
      Number(id),
    );
    return true;
  },
  remove(id) {
    return stmts.deleteRenderJob.run(Number(id)).changes > 0;
  },
  /** v1.9.2 渲染自愈：把崩溃遗留的 rendering 任务复位回 queued（重新渲染），返回复位条数 */
  resetStuck() {
    return stmts.resetStuckRenderJobs.run().changes;
  },
};

/* ---------------- v1.6.1：单实例工作锁 ----------------
 * 后台工作器（轮询/提交/渲染）全局只允许一个实例持有：
 * 多个控制台进程共用同一 SQLite 时，锁的持有者才运行工作器，
 * 其余实例仅提供 API——根治孤儿进程抢占任务队列的问题。
 * 心跳 10s，锁过期判定 15s（持有者进程消亡后可被接管）。 */

const INSTANCE_LOCK_KEY = 'instance_lock';

function getInstanceLock() {
  try {
    return JSON.parse(settings.get(INSTANCE_LOCK_KEY) || 'null');
  } catch {
    return null;
  }
}

/** 锁是否被「其他存活进程」持有（心跳过期视为无主） */
function instanceLockHeldByOther() {
  const l = getInstanceLock();
  if (!l || l.pid === process.pid) return false;
  if (Date.now() - (l.heartbeat || 0) > 15_000) return false;
  try {
    process.kill(l.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInstanceLock() {
  // v1.9.2 原子化：检查 + 写入压成单条 upsert CAS（语句级写锁跨进程原子），
  // 消除双进程同时启动时「都通过检查 → 都写入 → 都拿到锁」的 TOCTOU 窗口。
  // 语义与旧版差异：心跳新鲜但持有进程实际已死时不再即时抢锁（旧版靠 kill(pid,0)），
  // 而是等心跳过期（≤15s）后由接管循环获得——收敛稍慢但避免了 Windows pid 复用误判。
  const r = stmts.casInstanceLock.run(
    INSTANCE_LOCK_KEY,
    JSON.stringify({ pid: process.pid, heartbeat: Date.now() }),
    process.pid,
    Date.now() - 15_000, // 锁过期阈值（与 instanceLockHeldByOther 一致）
  );
  return r.changes > 0;
}

/** 持有者心跳；锁无主时顺带接管 */
function refreshInstanceLock() {
  if (!instanceLockHeldByOther()) {
    settings.set(INSTANCE_LOCK_KEY, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
  }
}

module.exports = {
  db,
  settings,
  tasks,
  projects,
  renders,
  tx,
  DEFAULT_SETTINGS,
  DB_PATH,
  DATA_DIR,
  acquireInstanceLock,
  instanceLockHeldByOther,
  refreshInstanceLock,
};
