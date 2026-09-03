'use strict';
/**
 * db/repos/renders.js —— render_jobs 表仓库（M3-P3）
 */
const path = require('node:path');
const { parseJson } = require('../kernel');
const stmts = require('../sql');

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
module.exports = renders;
