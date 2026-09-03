'use strict';
/**
 * db/sql.js —— SQL 预备语句注册表（M3-P3 自根 db.js 的 stmts 拆出）
 * 各 repos（db/repos/*）从这里取 prepare 语句；单一注册表便于整体审查。
 */
const { db } = require('./kernel');

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
};
module.exports = stmts;
