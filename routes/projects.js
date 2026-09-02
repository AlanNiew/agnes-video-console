'use strict';
/**
 * routes/projects.js —— 创作工作台域：项目 CRUD / 文案版本 / 图片定稿 / 镜头工作副本 /
 * 分镜版本选用 / 视频任务提交入口 / 重拍与定稿（v1.9.1 拆分自 server.js）
 */
const { projects } = require('../db');
const { createPipelineService } = require('../services/pipeline');
const { log } = require('../core/logger');
const autoPipeline = require('../workers/auto');
const {
  ASPECT_RATIOS,
  SECONDS_OK,
  PROJECT_STATUSES,
  MAX_SHOTS,
  MAX_TEXT_LEN,
  SHOT_MODES,
} = require('../core/constants');
const { ApiError, ah } = require('../core/errors');
const { buildPayload } = require('../services/payloads');
const { submitTask } = require('../services/task-queue');
const { normalizeStoryboardShots } = require('../services/prompts');

/* 流水线服务层（镜头/项目视频提交编排，M2） */
const pipeline = createPipelineService({ projects, buildPayload, submitTask, ApiError, log });

module.exports = function registerProjectRoutes(app) {
  /* ---------- P3：全自动成片（启动 / 状态 / 停止） ---------- */
  // 启动：从文案到成片全自动推进（失败自动重试，卡住停在人工介入点）
  app.post(
    '/api/projects/:id/auto',
    ah(async (req, res) => {
      const r = autoPipeline.launch(Number(req.params.id));
      if (!r.ok) throw new ApiError(r.code, r.message);
      res.status(202).json({ ok: true, auto_state: r.state });
    }),
  );
  // 状态（前端进度时间线数据源）
  app.get('/api/projects/:id/auto', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    res.json({ auto_state: p.auto_state, stage_meta: autoPipeline.STAGE_META });
  });
  // 停止（保留已产出内容）
  app.post(
    '/api/projects/:id/auto/stop',
    ah(async (req, res) => {
      const r = autoPipeline.stopProject(Number(req.params.id));
      if (!r.ok) throw new ApiError(r.code, r.message);
      res.json({ ok: true, auto_state: r.state });
    }),
  );

  app.post('/api/projects', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw new ApiError(400, '项目名称不能为空');
    if (b.aspect_ratio && !ASPECT_RATIOS.includes(b.aspect_ratio))
      throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
    if (b.seconds && !SECONDS_OK.includes(String(b.seconds))) throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
    const id = projects.insert({
      name,
      idea: b.idea,
      style: b.style,
      aspect_ratio: b.aspect_ratio,
      seconds: b.seconds,
    });
    res.status(201).json(projects.get(id));
  });

  app.get('/api/projects', (req, res) => res.json({ items: projects.list() }));

  app.get('/api/projects/:id', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    res.json({
      project: p,
      texts: projects.texts(p.id),
      images: projects.images(p.id),
      shots: projects.shots(p.id),
      tasks: projects.tasks(p.id),
      tts: projects.tts(p.id), // TTS 配音记录
    });
  });

  app.patch('/api/projects/:id', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const b = req.body || {};
    if (b.name !== undefined) {
      const n = String(b.name).trim();
      if (!n) throw new ApiError(400, '项目名称不能为空');
      b.name = n;
    }
    if (b.status !== undefined && !PROJECT_STATUSES.includes(b.status)) {
      throw new ApiError(400, `status 仅支持 ${PROJECT_STATUSES.join('/')}`);
    }
    if (b.aspect_ratio !== undefined && b.aspect_ratio !== null && !ASPECT_RATIOS.includes(b.aspect_ratio))
      throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
    if (b.seconds !== undefined && b.seconds !== null && !SECONDS_OK.includes(String(b.seconds)))
      throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
    if (b.idea !== undefined && b.idea !== null && String(b.idea).length > MAX_TEXT_LEN)
      throw new ApiError(400, `idea 长度需 ≤ ${MAX_TEXT_LEN}`);
    if (b.style !== undefined && b.style !== null) b.style = String(b.style).trim().slice(0, 200) || null;
    projects.update(p.id, {
      name: b.name,
      idea: b.idea,
      style: b.style,
      aspect_ratio: b.aspect_ratio,
      seconds: b.seconds,
      status: b.status,
    });
    res.json(projects.get(p.id));
  });

  app.delete('/api/projects/:id', (req, res) => {
    if (!projects.remove(req.params.id)) throw new ApiError(404, '项目不存在');
    res.json({ ok: true });
  });

  // 选定文案版本（同一 kind 只有一条 selected）
  app.post('/api/projects/:id/select-text', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const textId = Number(req.body?.text_id);
    const target = projects.texts(p.id).find((t) => t.id === textId);
    if (!target) throw new ApiError(404, '文案记录不存在');
    projects.selectText(textId, target.kind, p.id);
    res.json({ ok: true });
  });

  // 编辑文案版本内容（手动微调；校验文案归属当前项目，防跨项目越权编辑）
  app.patch('/api/projects/:id/texts/:textId', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const content = String(req.body?.content ?? '').trim();
    if (!content) throw new ApiError(400, '内容不能为空');
    if (content.length > MAX_TEXT_LEN) throw new ApiError(400, `内容长度需 ≤ ${MAX_TEXT_LEN}`);
    const target = projects.texts(p.id).find((t) => t.id === Number(req.params.textId));
    if (!target) throw new ApiError(404, '文案记录不存在');
    if (!projects.updateText(target.id, content)) throw new ApiError(404, '文案记录不存在');
    res.json({ ok: true });
  });

  // 选定图片定稿（同一 kind 只有一张 selected）
  app.post('/api/projects/:id/select-image', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const imgId = Number(req.body?.image_id);
    const target = projects.images(p.id).find((x) => x.id === imgId);
    if (!target) throw new ApiError(404, '图片记录不存在');
    projects.selectImage(imgId, target.kind, p.id);
    res.json({ ok: true });
  });

  // 选用历史 storyboard 版本 → 重建镜头工作副本（选中该版本 + 整体替换 shots）
  app.post('/api/projects/:id/storyboard/apply', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const textId = Number(req.body?.text_id);
    const target = projects.texts(p.id).find((t) => t.id === textId && t.kind === 'storyboard');
    if (!target) throw new ApiError(404, 'storyboard 版本不存在');
    let parsedContent;
    try {
      parsedContent = JSON.parse(target.content || '{}');
    } catch {
      throw new ApiError(400, '该 storyboard 版本内容不是合法 JSON');
    }
    const shots = normalizeStoryboardShots(parsedContent.shots, p.seconds || '5');
    if (!shots.length) throw new ApiError(400, '该 storyboard 版本没有有效镜头');
    projects.selectText(target.id, 'storyboard', p.id);
    projects.replaceShots(p.id, shots);
    log('info', `项目 #${p.id} 选用 storyboard 版本 #${target.id}（${shots.length} 个镜头）`);
    res.json({ ok: true, shots: projects.shots(p.id) });
  });

  // 手动添加镜头（追加到末尾）
  app.post('/api/projects/:id/shots', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const existing = projects.shots(p.id);
    if (existing.length >= MAX_SHOTS) throw new ApiError(400, `每个项目最多 ${MAX_SHOTS} 个镜头`);
    const b = req.body || {};
    const vp = String(b.video_prompt || '').trim();
    if (!vp) throw new ApiError(400, 'video_prompt 不能为空');
    if (vp.length > MAX_TEXT_LEN) throw new ApiError(400, `video_prompt 长度需 ≤ ${MAX_TEXT_LEN}`);
    if (b.seconds !== undefined && b.seconds !== null && !SECONDS_OK.includes(String(b.seconds))) {
      throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
    }
    const mode = SHOT_MODES.includes(b.mode) ? b.mode : 'reference';
    const maxSeq = existing.reduce((m, s) => Math.max(m, s.seq), 0);
    const id = projects.addShot({
      project_id: p.id,
      seq: maxSeq + 1,
      title:
        String(b.title || '')
          .trim()
          .slice(0, 100) || null,
      video_prompt: vp,
      seconds: b.seconds || null,
      mode,
      narration: b.narration !== undefined && b.narration !== null ? String(b.narration) : undefined,
      use_character_ref: b.use_character_ref,
    });
    res.status(201).json(projects.shots(p.id).find((s) => s.id === id));
  });

  // 编辑镜头（标题/提示词/时长/旁白/引用开关；归属校验防跨项目越权）
  app.patch('/api/projects/:id/shots/:shotId', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
    if (!shot) throw new ApiError(404, '镜头不存在');
    const b = req.body || {};
    const patch = {};
    if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 100) || null;
    if (b.video_prompt !== undefined) {
      const vp = String(b.video_prompt).trim();
      if (!vp) throw new ApiError(400, 'video_prompt 不能为空');
      if (vp.length > MAX_TEXT_LEN) throw new ApiError(400, `video_prompt 长度需 ≤ ${MAX_TEXT_LEN}`);
      patch.video_prompt = vp;
    }
    if (b.seconds !== undefined) {
      if (b.seconds !== null && !SECONDS_OK.includes(String(b.seconds)))
        throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
      patch.seconds = b.seconds;
    }
    // v1.3：旁白文案与角色引用开关
    if (b.narration !== undefined) {
      patch.narration = b.narration === null ? null : String(b.narration).trim().slice(0, 200) || null;
    }
    if (b.use_character_ref !== undefined) {
      patch.use_character_ref = b.use_character_ref ? 1 : 0;
    }
    projects.updateShot(shot.id, patch);
    res.json(projects.shots(p.id).find((s) => s.id === shot.id));
  });

  // 删除镜头（关联视频任务保留，shot_id 成为历史引用）
  app.delete('/api/projects/:id/shots/:shotId', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
    if (!shot) throw new ApiError(404, '镜头不存在');
    projects.removeShot(shot.id);
    res.json({ ok: true });
  });

  // 镜头排序：ids 按新顺序给出，必须与现有镜头一一对应（不重不漏）
  app.post('/api/projects/:id/shots/reorder', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) throw new ApiError(400, 'ids 必须是非空数组');
    const current = projects.shots(p.id);
    const idSet = new Set(current.map((s) => s.id));
    const reqIds = ids.map(Number);
    if (
      reqIds.length !== current.length ||
      reqIds.some((id) => !idSet.has(id)) ||
      new Set(reqIds).size !== reqIds.length
    ) {
      throw new ApiError(400, 'ids 必须与项目现有镜头一一对应（不重不漏）');
    }
    projects.reorderShots(p.id, reqIds);
    res.json({ ok: true, shots: projects.shots(p.id) });
  });

  // 单镜头提交视频任务（M2 主入口；复用 pipeline 服务层组装与溯源）
  app.post(
    '/api/projects/:id/shots/:shotId/videos',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
      if (!shot) throw new ApiError(404, '镜头不存在');
      const b = req.body || {};
      const task = await pipeline.submitVideoTask({
        projectId: p.id,
        shot, // v1.3：传入镜头行，pipeline 据此尊重 use_character_ref / mode
        prompt: shot.video_prompt,
        seconds: b.seconds || shot.seconds,
        aspectRatio: b.aspect_ratio,
        shotId: shot.id,
      });
      res.status(201).json(task);
    }),
  );

  // v1.7 镜头重拍：一次提交 N 条候选任务（提交队列自动按分钟节流；完成后在下方选定 take）
  app.post(
    '/api/projects/:id/shots/:shotId/retakes',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
      if (!shot) throw new ApiError(404, '镜头不存在');
      const b = req.body || {};
      const count = Math.min(Math.max(Math.round(Number(b.count) || 1), 1), 3);
      const created = [];
      for (let i = 0; i < count; i++) {
        const task = await pipeline.submitVideoTask({
          projectId: p.id,
          shot,
          prompt: shot.video_prompt,
          seconds: b.seconds || shot.seconds,
          aspectRatio: b.aspect_ratio,
          shotId: shot.id,
        });
        created.push({ id: task.id, status: task.status });
      }
      log('info', `项目 #${p.id} 镜头 #${shot.id}（seq ${shot.seq}）重拍 ${created.length} 条候选`);
      res.status(201).json({ ok: true, retakes: created });
    }),
  );

  // v1.7 镜头选定定稿 take：{task_id}（须为该镜头已完成且有产物的任务）；task_id=null 恢复自动模式
  app.post('/api/projects/:id/shots/:shotId/select-take', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
    if (!shot) throw new ApiError(404, '镜头不存在');
    const raw = req.body?.task_id;
    if (raw === null || raw === undefined || raw === '') {
      projects.setShotTake(shot.id, null);
      log('info', `镜头 #${shot.id} 恢复自动模式（渲染用最新完成条）`);
      return res.json({ ok: true, shot: projects.shots(p.id).find((s) => s.id === shot.id) });
    }
    const taskId = Number(raw);
    const task = projects.tasks(p.id).find((t) => t.id === taskId && t.shot_id === shot.id);
    if (!task) throw new ApiError(404, '任务不存在（或不属于该镜头）');
    if (task.status !== 'completed' || (!task.video_local_path && !task.metadata_url)) {
      throw new ApiError(400, '只有已完成且有产物的任务才能定为定稿 take');
    }
    projects.setShotTake(shot.id, taskId);
    log('info', `镜头 #${shot.id}（seq ${shot.seq}）选定定稿 take：任务 #${taskId}`);
    res.json({ ok: true, shot: projects.shots(p.id).find((s) => s.id === shot.id) });
  });

  // 从项目发起视频任务（旧入口，保留原语义）：角色定稿图 + 选定分镜提示词 → 2.5-flash reference 模式。
  // 组装与溯源逻辑在 pipeline.js 服务层；M2 起新流程走 /api/projects/:id/shots/:shotId/videos
  app.post(
    '/api/projects/:id/videos',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      const b = req.body || {};
      let prompt = String(b.prompt || '').trim();
      if (!prompt) {
        const selectedVideo = projects.selectedText(p.id, 'video_prompt');
        prompt = selectedVideo?.content || '';
      }
      if (!prompt) {
        const latest = projects.texts(p.id).find((t) => t.kind === 'video_prompt');
        prompt = latest?.content || '';
      }
      const task = await pipeline.submitVideoTask({
        projectId: p.id,
        prompt,
        seconds: b.seconds,
        aspectRatio: b.aspect_ratio,
      });
      res.status(201).json(task);
    }),
  );
};
