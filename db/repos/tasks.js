'use strict';
/**
 * db/repos/tasks.js —— tasks 表仓库（M3-P3）：行映射 + 任务命名空间。
 * 附加导出 toTaskRow 供 projects repo 聚合任务行复用。
 */
const path = require('node:path');
const { parseJson } = require('../kernel');
const stmts = require('../sql');

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
module.exports = tasks;
module.exports.toTaskRow = toTaskRow;
