'use strict';
/**
 * routes/tasks.js —— 任务中心：列表 / 创建 / 重试 / 轮询 / 删除 / 批量清理 / 统计
 * （v1.9.1 拆分自 server.js）
 */
const { tasks, projects, tx } = require('../db');
const poller = require('../poller');
const submitter = require('../submitter');
const imageWorker = require('../image-worker');
const { log } = require('../logger');
const { ApiError, ah } = require('../errors');
const { buildPayload, submitTask } = require('../services/payloads'); // 创建任务仍走入队语义

module.exports = function registerTaskRoutes(app) {
  // 统计
  app.get('/api/stats', (req, res) => res.json(tasks.stats()));

  // 任务列表（过滤 + 搜索 + 分页；v2.0 起返回 total=满足当前筛选的总条数，供前端翻页）
  app.get('/api/tasks', (req, res) => {
    const { status, q, limit, offset } = req.query;
    const { items, total } = tasks.page({
      status: ['queued', 'in_progress', 'completed', 'failed', 'submit_error'].includes(status) ? status : null,
      q: q ? String(q).slice(0, 200) : null,
      limit,
      offset,
    });
    res.json({
      items,
      total,
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

  // 重试（v2.1：原任务原地重新入队——失败 → 队列中 → 生成中 → 完成/失败，任务 ID 不变，
  // 不再新建记录；输入参数与 project/shot/image 溯源全部保留，retry_count 自增）
  app.post(
    '/api/tasks/:id/retry',
    ah(async (req, res) => {
      const t = tasks.get(req.params.id);
      if (!t) throw new ApiError(404, '任务不存在');
      if (!['failed', 'submit_error'].includes(t.status)) {
        throw new ApiError(400, `仅 failed / submit_error 状态可重试，当前状态：${t.status}`);
      }
      const retried = tasks.retry(t.id);
      if (!retried) throw new ApiError(409, '重试失败（任务状态可能已被并发修改，请刷新后重试）');
      submitter.kick(retried.id); // 清退避标记并唤醒提交器（图片任务由 image-worker 自然接管）
      imageWorker.kick(retried.id);
      log(
        'info',
        `任务 #${retried.id} 已重新入队（第 ${retried.retry_count} 次重试，原任务原地流转，${retried.kind === 'image' ? '图片' : '视频'}任务）`,
      );
      res.json({ ok: true, task: retried, reused: true });
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
