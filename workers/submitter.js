'use strict';
/**
 * submitter.js —— 后台提交器（v1.3）
 * 接管「已入队但尚未提交上游」的任务（queued 且无 video_id）：
 * - 按模型串行提交，最小间隔由设置 submit_interval_ms 控制（服务端强制，
 *   根治上游「1 次/分钟」限流导致批量提交撞 429 的问题）
 * - 429 / 网络错误 / 5xx 自动指数退避重试，重试耗尽才落 submit_error
 * - 其余 4xx（鉴权/参数等）不可恢复，直接 submit_error
 */
const { settings, tasks, instanceLockHeldByOther } = require('../db');
const agnes = require('../clients/agnes');
const { log } = require('../core/logger');
const { DEFAULT_BASE_URL } = require('../core/config');

const TICK_MS = 1000;
const MAX_ATTEMPTS = 5;
// 429 首次退避基数：默认 60s（对齐免费档 1 次/分钟）；测试可用 SUBMIT_RATE_LIMIT_BASE_MS 覆盖
const RATE_LIMIT_BASE_MS = Math.max(Number(process.env.SUBMIT_RATE_LIMIT_BASE_MS) || 60_000, 1_000);
const RATE_LIMIT_CAP_MS = Number(process.env.SUBMIT_RATE_LIMIT_BASE_MS)
  ? Math.max(RATE_LIMIT_BASE_MS * 8, 10_000)
  : 10 * 60_000;
const NET_BASE_MS = 10_000;
const NET_CAP_MS = 60_000;

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

/**
 * 退避延迟计算（指数退避 + 上限）
 * @param {number} attempts 重试次数（从 1 起）
 * @param {'rate-limit'|'net'} kind 429 限流 / 网络异常（各自基数与上限）
 */
function computeBackoffMs(attempts, kind) {
  if (kind === 'net') return Math.min(NET_BASE_MS * 2 ** (attempts - 1), NET_CAP_MS);
  return Math.min(RATE_LIMIT_BASE_MS * 2 ** (attempts - 1), RATE_LIMIT_CAP_MS);
}

class Submitter {
  constructor() {
    this.timer = null;
    this.running = false;
    this.lastSubmitAt = new Map(); // model -> 上次成功提交时间戳（服务端最小间隔）
    this.retryUntil = new Map(); // taskId -> { until, attempts }
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) => log('error', `提交循环异常: ${e.message}`)), TICK_MS);
    this.timer.unref?.();
    log('info', '提交器已启动（按 submit_interval_ms 服务端节流，429 自动退避重试）');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 唤醒：清除指定任务的退避标记（入队后立即尝试首次提交） */
  kick(taskId) {
    if (taskId) this.retryUntil.delete(Number(taskId));
  }

  async tick() {
    if (this.running) return;
    if (instanceLockHeldByOther()) return; // v1.6.1 工作锁
    this.running = true;
    try {
      const interval = Math.max(Number(settings.get('submit_interval_ms', 60_000)) || 0, 0);
      for (const t of tasks.pendingSubmit()) {
        const last = this.lastSubmitAt.get(t.model) || 0;
        if (interval > 0 && Date.now() - last < interval) continue; // 模型间隔未到
        const bo = this.retryUntil.get(t.id);
        if (bo && bo.until > Date.now()) continue; // 任务退避中
        await this.submitOne(t);
      }
    } finally {
      this.running = false;
    }
  }

  backoff(taskId, delay, attempts) {
    this.retryUntil.set(taskId, { until: Date.now() + delay, attempts });
  }

  fail(taskId, message, submitResponse = null) {
    tasks.update(taskId, { status: 'submit_error', error_message: message, submit_response: submitResponse });
    this.retryUntil.delete(taskId);
    log('error', `任务 #${taskId} 提交失败：${message}`);
  }

  async submitOne(t) {
    const apiKey = settings.get('api_key', '');
    if (!apiKey) return; // 未配置 Key：保留入队状态，配置后下一轮自动提交
    const payload = t.request_json;
    if (!payload) {
      this.fail(t.id, '任务缺少 request_json（历史数据异常），无法提交');
      return;
    }
    const baseUrl = settings.get('base_url', DEFAULT_BASE_URL);
    const prev = this.retryUntil.get(t.id);
    const attempts = prev ? prev.attempts + 1 : 1;

    let r;
    try {
      r = await agnes.createTask({ apiKey, baseUrl, payload });
    } catch (e) {
      if (attempts >= MAX_ATTEMPTS) {
        this.fail(t.id, `提交网络异常（自动重试 ${attempts - 1} 次）：${e.message}`);
        return;
      }
      this.backoff(t.id, computeBackoffMs(attempts, 'net'), attempts);
      log('warn', `任务 #${t.id} 提交网络异常（第 ${attempts} 次）：${e.message}`);
      return;
    }

    if (r.status === 429) {
      if (attempts >= MAX_ATTEMPTS) {
        const detail = String(r.data?.detail || r.data?.error?.message || r.raw || '').slice(0, 300);
        this.fail(t.id, `提交限流（429），自动重试 ${attempts - 1} 次仍失败：${detail}`, r.data);
        return;
      }
      const delay = computeBackoffMs(attempts, 'rate-limit');
      this.backoff(t.id, delay, attempts);
      log(
        'warn',
        `任务 #${t.id} 触发 429 限流，${Math.round(delay / 1000)}s 后自动重试（${attempts}/${MAX_ATTEMPTS}）`,
      );
      return;
    }

    if (!r.ok) {
      const detail = r.data?.detail || r.data?.error?.message || r.raw || `HTTP ${r.status}`;
      this.fail(t.id, `提交失败（${r.status}）：${String(detail).slice(0, 500)}`, r.data);
      return;
    }

    const j = r.data || {};
    this.lastSubmitAt.set(t.model, Date.now());
    this.retryUntil.delete(t.id);
    tasks.update(t.id, {
      task_id: j.task_id || j.id || null,
      video_id: j.video_id || null,
      submit_response: j,
      status: /^(queued|in_progress|completed|failed)$/.test(j.status) ? j.status : 'queued',
      progress: Number.isFinite(j.progress) ? Number(j.progress) : 0,
      metadata_url: safeUrl(j.metadata?.url) || safeUrl(j.url),
      submitted_at: Date.now(),
    });
    log('info', `任务 #${t.id} 提交成功 video_id=${j.video_id || '(null)'} status=${j.status || 'queued'}`);
  }
}

module.exports = new Submitter();
// 纯函数与常量导出（供单元测试断言退避数学；submitter 单例仍为默认导出）
module.exports.computeBackoffMs = computeBackoffMs;
