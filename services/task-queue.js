'use strict';
/**
 * services/task-queue.js —— 任务入队服务（v1.3 提交队列语义；M2 从 services/payloads.js 拆出）
 * 「创建任务记录 + 唤醒提交器」的领域动作单独成模块：
 * - services/payloads.js 保持纯校验/组装，不依赖任何后台 worker；
 * - 本模块承担入队编排（建 queued 记录 + kick 提交器），
 *   与后台节流提交器 workers/submitter.js 是两回事（那是执行者，这里是入队动作）。
 */
const { settings, tasks } = require('../db');
const submitter = require('../workers/submitter');
const { log } = require('../core/logger');
const { ApiError } = require('../core/errors');

/** 创建任务记录并进入提交队列（v1.3）：
 * 不再同步调用上游 —— 由后台提交器（workers/submitter.js）按 submit_interval_ms 节流提交，
 * 429 / 网络错误自动退避重试，把「限流撞墙」变成「排队等待」。 */
async function submitTask(payload, meta, opts = {}) {
  const apiKey = settings.get('api_key', '');
  if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');

  const id = tasks.insert({
    status: 'queued',
    ...meta,
    request_json: payload,
    project_id: opts.project_id || null,
    shot_id: opts.shot_id || null,
    text_id: opts.text_id || null,
    image_id: opts.image_id || null,
  });
  submitter.kick(id); // 立即唤醒提交器尝试首次提交（是否放行仍受最小间隔约束）
  log('info', `任务 #${id} 已入队（${meta.model}，后台提交器按间隔提交，429 自动重试）`);
  return tasks.get(id);
}

module.exports = { submitTask };
