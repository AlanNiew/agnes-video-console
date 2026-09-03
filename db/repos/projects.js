'use strict';
/**
 * db/repos/projects.js —— projects 域仓库（M3-P3）
 * 项目主实体 + 文案(project_texts) + 图片(project_images) + 镜头(shots) + 配音(project_tts)
 * 的 CRUD 与级联删除（A 档：表族拆四文件，对外契约 projects.* 不变）。
 */
const path = require('node:path');
const fs = require('node:fs');
const { parseJson, tx } = require('../kernel');
const stmts = require('../sql');
const { toTaskRow } = require('./tasks');

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
    // 纯查询：项目全部相关任务行。superseded 展示标注已上移（M3）——
    // 由 API 聚合层（routes/projects.js annotateSuperseded）负责，数据层不再写视图逻辑。
    return stmts.listProjectTasks.all(Number(projectId)).map(toTaskRow);
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
module.exports = projects;
