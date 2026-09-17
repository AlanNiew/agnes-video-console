'use strict';
/**
 * routes/tasks.js —— 任务中心：列表 / 创建 / 重试 / 轮询 / 删除 / 批量清理 / 统计
 * （v1.9.1 拆分自 server.js）
 */
const { tasks, projects, tx } = require('../db');
const manager = require('../workers/manager');
const { log } = require('../core/logger');
const { ApiError, ah } = require('../core/errors');
const { buildPayload, buildImagePayload } = require('../services/payloads');
const { providerOf } = require('../core/constants');
const { submitTask } = require('../services/task-queue'); // 创建任务仍走入队语义
const { computeVideoMetrics } = require('../lib/video-metrics'); // v2.5 镜头级客观指标

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

  // v2.5 镜头级客观指标（筛查抖动/闪烁/运动幅度；供 AI 与人工优先复核可疑镜头）
  app.get(
    '/api/tasks/:id/metrics',
    ah(async (req, res) => {
      const t = tasks.get(req.params.id);
      if (!t) throw new ApiError(404, '任务不存在');
      const src = t.video_local_path || t.metadata_url;
      if (t.status !== 'completed' || !src) throw new ApiError(400, '仅已完成且有视频产物的任务可计算指标');
      const m = computeVideoMetrics(src);
      if (!m) throw new ApiError(400, '指标计算失败（需本机 ffmpeg，且素材可读）');
      res.json({ ok: true, task_id: t.id, shot_id: t.shot_id, metrics: m });
    }),
  );

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
      manager.kickTask(retried.id); // 清退避标记并唤醒提交器/图片工作器按其类型接管
      log(
        'info',
        `任务 #${retried.id} 已重新入队（第 ${retried.retry_count} 次重试，原任务原地流转，${retried.kind === 'image' ? '图片' : '视频'}任务）`,
      );
      res.json({ ok: true, task: retried, reused: true });
    }),
  );

  // v2.6 跨上游升级（docs/DREAMINA_CLI_PLAN.md 阶段 5）：把失败任务改用另一上游重试
  // （如 Agnes → 即梦），任务 ID 不变、project/shot 溯源保留。
  // payload 由服务端用目标模型重建（两个上游的结构完全不同，不在数据层拼装）。
  // 刻意**不自动触发**：必须前端显式调用（并先过成本护栏），避免用户不知情时扣费。
  app.post(
    '/api/tasks/:id/upgrade',
    ah(async (req, res) => {
      const t = tasks.get(req.params.id);
      if (!t) throw new ApiError(404, '任务不存在');
      if (!['failed', 'submit_error'].includes(t.status)) {
        throw new ApiError(400, `仅 failed / submit_error 状态可升级，当前状态：${t.status}`);
      }
      const targetModel = String((req.body || {}).model || '').trim();
      if (!targetModel) throw new ApiError(400, '缺少目标模型 model');
      const from = providerOf(t.model);
      const to = providerOf(targetModel);
      if (from === to) {
        throw new ApiError(400, `升级目标须为另一上游（当前 ${from} → 目标 ${to}）；同上游请用「重试」`);
      }

      // 沿用原任务的输入参数，仅替换模型（payload 结构差异由 build* 处理）
      const src = t.request_json || {};
      const isImage = t.kind === 'image';
      const input = isImage
        ? {
            model: targetModel,
            prompt: src.prompt || t.prompt,
            size: src.size || t.size,
            ratio: src.ratio || t.aspect_ratio,
            count: src.count || 1,
          }
        : {
            model: targetModel,
            prompt: src.prompt || t.prompt,
            mode: src.mode || t.mode || 'text',
            seconds: src.seconds || t.seconds,
            size: src.size || t.size,
            aspect_ratio: src.aspect_ratio || t.aspect_ratio,
          };

      // 注意：buildPayload 可能抛 400（例如原任务是 reference 模式而目标是即梦，
      // 即梦仅支持 text）——这正是期望行为，由 ah 转成明确错误返回给前端。
      let payload;
      if (isImage) {
        const built = buildImagePayload(input);
        // 图片任务的 request_json 需带 count 与 image_kind（与 routes/images.js 入队时一致）
        payload = { ...built.payload, count: input.count, image_kind: src.image_kind ?? null };
      } else {
        payload = buildPayload(input).payload;
      }

      const upgraded = tasks.upgrade(t.id, { model: targetModel, request_json: payload });
      if (!upgraded) throw new ApiError(409, '升级失败（任务状态可能已被并发修改，请刷新后重试）');
      manager.kickTask(upgraded.id); // 清退避标记并唤醒对应 worker
      log(
        'info',
        `任务 #${upgraded.id} 已升级：${t.model}(${from}) → ${targetModel}(${to})，第 ${upgraded.retry_count} 次重试`,
      );
      res.json({ ok: true, task: upgraded, upgraded_from: t.model, upgraded_to: targetModel });
    }),
  );

  // 立即强制轮询
  app.post(
    '/api/tasks/:id/poll',
    ah(async (req, res) => {
      try {
        const status = await manager.pollNow(req.params.id);
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
