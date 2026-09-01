'use strict';
/**
 * routes/tasks.js —— 任务中心：列表 / 创建 / 重试 / 轮询 / 删除 / 批量清理 / 统计
 * （v1.9.1 拆分自 server.js）
 */
const { tasks, projects, tx } = require('../db');
const poller = require('../poller');
const { log } = require('../logger');
const { ApiError, ah } = require('../errors');
const { buildPayload, submitTask } = require('../services/payloads');

module.exports = function registerTaskRoutes(app) {
  // 统计
  app.get('/api/stats', (req, res) => res.json(tasks.stats()));

  // 任务列表（过滤 + 搜索 + 分页）
  app.get('/api/tasks', (req, res) => {
    const { status, q, limit, offset } = req.query;
    res.json({
      items: tasks.list({
        status: ['queued', 'in_progress', 'completed', 'failed', 'submit_error'].includes(status) ? status : null,
        q: q ? String(q).slice(0, 200) : null,
        limit,
        offset,
      }),
      stats: tasks.stats(),
    });
  });

  // 创建任务（v1.7.1：可选 project_id / shot_id 关联，供自动化工作流[如图生视频产线]溯源；校验归属）
  app.post(
    '/api/tasks',
    ah(async (req, res) => {
      const { payload, meta } = buildPayload(req.body);
      const b = req.body || {};
      let projectId = null;
      let shotId = null;
      if (b.project_id !== undefined && b.project_id !== null && b.project_id !== '') {
        projectId = Number(b.project_id);
        if (!projects.get(projectId)) throw new ApiError(404, '项目不存在');
        if (b.shot_id !== undefined && b.shot_id !== null && b.shot_id !== '') {
          shotId = Number(b.shot_id);
          if (!projects.shots(projectId).some((s) => s.id === shotId))
            throw new ApiError(404, '镜头不存在（或不属于该项目）');
        }
      }
      const task = await submitTask(payload, meta, { project_id: projectId, shot_id: shotId });
      res.status(201).json(task);
    }),
  );

  // 查询单个任务
  app.get('/api/tasks/:id', (req, res) => {
    const t = tasks.get(req.params.id);
    if (!t) throw new ApiError(404, '任务不存在');
    res.json(t);
  });

  // 重试（以原参数创建新任务，保留失败记录便于审计）
  app.post(
    '/api/tasks/:id/retry',
    ah(async (req, res) => {
      const t = tasks.get(req.params.id);
      if (!t) throw new ApiError(404, '任务不存在');
      if (!['failed', 'submit_error'].includes(t.status)) {
        throw new ApiError(400, `仅 failed / submit_error 状态可重试，当前状态：${t.status}`);
      }
      const meta = {
        model: t.model,
        mode: t.mode,
        prompt: t.prompt,
        seconds: t.seconds,
        size: t.size,
        aspect_ratio: t.aspect_ratio,
        seed: t.seed,
        first_frame: t.first_frame,
        last_frame: t.last_frame,
        images: t.images,
        audios: t.audios,
        videos: t.videos,
        image: t.image,
        num_frames: t.num_frames,
        frame_rate: t.frame_rate,
        width: t.width,
        height: t.height,
        negative_prompt: t.negative_prompt,
      };
      // v1.9 修复：重试保留溯源（网络波动重试不再丢 project/shot 关联，避免渲染跳过镜头）
      const opts = {
        project_id: t.project_id || null,
        shot_id: t.shot_id || null,
        image_id: t.image_id || null,
      };
      const { payload } = buildPayload(meta);
      const task = await submitTask(payload, meta, opts);
      log('info', `任务 #${t.id} 重试 → 新任务 #${task.id}（project=${t.project_id} shot=${t.shot_id}）`);
      res.status(201).json({ old: t, task });
    }),
  );

  // 立即强制轮询
  app.post(
    '/api/tasks/:id/poll',
    ah(async (req, res) => {
      try {
        const status = await poller.pollNow(req.params.id);
        res.json({ ok: true, status });
      } catch (e) {
        throw new ApiError(e.message === '任务不存在' ? 404 : 400, e.message);
      }
    }),
  );

  // 删除任务记录（若某镜头的定稿 take 引用它，则清引用回退自动模式）
  app.delete('/api/tasks/:id', (req, res) => {
    if (!tasks.remove(req.params.id)) throw new ApiError(404, '任务不存在');
    projects.clearShotTakeByTask(Number(req.params.id));
    res.json({ ok: true });
  });

  // 批量操作
  app.post('/api/tasks/bulk/clear-completed', (req, res) => {
    const n = tasks.clearCompleted();
    res.json({ ok: true, removed: n });
  });
  app.post('/api/tasks/bulk/clear-failed', (req, res) => {
    const failed = tasks.list({ status: 'failed', limit: 500 });
    const fe = tasks.list({ status: 'submit_error', limit: 500 });
    const n = tx(() => {
      let c = 0;
      for (const t of [...failed, ...fe]) if (tasks.remove(t.id)) c++;
      return c;
    });
    res.json({ ok: true, removed: n });
  });
};
