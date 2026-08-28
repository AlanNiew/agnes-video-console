'use strict';
/**
 * poller.js —— 后台轮询器
 * 每隔 poll_interval_ms 轮询所有进行中（queued / in_progress）任务；
 * 429 / 网络错误按指数退避；超过 max_active_minutes 的任务标记为失败（轮询超时）。
 */
const { settings, tasks } = require('./db');
const agnes = require('./agnes');
const { log } = require('./logger');

const RETRY_CAP_MS = 60_000; // 单任务退避上限 60s

class Poller {
  constructor() {
    this.timer = null;
    this.running = false;
    this.pollingIds = new Set(); // 正在轮询的任务 id（防止定时 tick 与手动 pollNow 并发轮询同一任务）
    this.retryUntil = new Map(); // taskId -> 允许再次轮询的时间戳
  }

  start() {
    this.stop();
    const interval = Math.max(Number(settings.get('poll_interval_ms', 2000)) || 2000, 500);
    this.timer = setInterval(() => this.tick().catch((e) => log('error', `轮询循环异常: ${e.message}`)), interval);
    this.timer.unref?.();
    log('info', `轮询器已启动，间隔 ${interval}ms`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getInterval() {
    return Math.max(Number(settings.get('poll_interval_ms', 2000)) || 2000, 500);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // 1) 清理悬挂任务：已提交但从未拿到 video_id（进程中断等）
      this.cleanStuck();
      // 2) 轮询进行中的任务
      const active = tasks.active();
      for (const t of active) {
        const due = this.retryUntil.get(t.id);
        if (due && due.until > Date.now()) continue; // 退避中
        await this.pollOne(t);
      }
    } finally {
      this.running = false;
    }
  }

  cleanStuck() {
    for (const t of tasks.stuck(60_000)) {
      tasks.update(t.id, {
        status: 'submit_error',
        error_message: '任务已提交但未获得 video_id（进程中断），请重试',
      });
      log('warn', `任务 #${t.id} 标记为 submit_error（无 video_id）`);
    }
  }

  async pollOne(t) {
    // 同一任务同一时刻只允许一个轮询在途，避免旧响应覆盖新状态
    if (this.pollingIds.has(t.id)) return;
    this.pollingIds.add(t.id);
    try {
      await this._pollOneInner(t);
    } finally {
      this.pollingIds.delete(t.id);
    }
  }

  async _pollOneInner(t) {
    const apiKey = settings.get('api_key', '');
    const baseUrl = settings.get('base_url', 'https://apihub.agnes-ai.com');
    const maxActiveMs = Math.max((Number(settings.get('max_active_minutes', 20)) || 20) * 60_000, 30_000);

    // 轮询超时保护：任务创建超过 max_active_minutes 仍未结束
    // （completed/failed 已是终态，手动「立即查询」不应再把它们翻成失败）
    if (t.status !== 'completed' && t.status !== 'failed' && Date.now() - t.created_at > maxActiveMs) {
      this.retryUntil.delete(t.id);
      tasks.setPollResult(t.id, {
        status: 'failed',
        progress: t.progress,
        last_poll_response: t.last_poll_response,
        error_message: `轮询超时（超过 ${Math.round(maxActiveMs / 60000)} 分钟未完成）`,
      });
      log('warn', `任务 #${t.id} (${t.video_id}) 轮询超时 → failed`);
      return;
    }

    if (!apiKey) {
      log('warn', `任务 #${t.id} 跳过轮询：未配置 API Key（请在设置中填写）`);
      return;
    }

    let r;
    try {
      r = await agnes.queryTask({ apiKey, baseUrl, videoId: t.video_id, model: t.model });
    } catch (e) {
      this.backoff(t.id, 5000);
      log('error', `任务 #${t.id} (${t.video_id}) 查询网络异常: ${e.message}`);
      return;
    }

    if (!r.ok) {
      switch (r.status) {
        case 404:
          tasks.setPollResult(t.id, {
            status: 'failed',
            last_poll_response: r.data,
            error_message: `video_id 不存在（404）：${r.raw}`,
          });
          log('error', `任务 #${t.id} video_id 不存在 → failed`);
          break;
        case 401:
        case 403:
          tasks.setPollResult(t.id, {
            status: 'failed',
            last_poll_response: r.data,
            error_message: `鉴权失败（${r.status}）：API Key 无效或过期`,
          });
          log('error', `任务 #${t.id} 鉴权失败（${r.status}）→ failed`);
          break;
        case 429:
          this.backoff(t.id);
          log('warn', `任务 #${t.id} 触发 429，退避 ${Math.floor(this.retryUntil.get(t.id).until - Date.now())}ms`);
          break;
        default:
          if (r.status >= 500) {
            this.backoff(t.id, 3000);
            log('warn', `任务 #${t.id} 服务端错误 ${r.status}，稍后重试`);
          } else {
            tasks.setPollResult(t.id, {
              status: 'failed',
              last_poll_response: r.data,
              error_message: `查询失败（${r.status}）：${r.raw}`,
            });
            log('error', `任务 #${t.id} 查询失败（${r.status}）→ failed`);
          }
      }
      return;
    }

    // 成功拿到响应
    const j = r.data || {};
    const status = j.status;
    const progress = Number.isFinite(j.progress) ? Number(j.progress) : t.progress;
    const errorMessage = j.error?.message || null;
    // 真实接口返回的视频地址可能在 metadata.url（文档）或顶层 url（实测），两者都兼容；
    // 落库前校验必须是 http(s) 地址，防止上游异常数据污染前端链接
    const rawUrl = j.metadata?.url || j.url || null;
    const metadataUrl = typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : null;
    this.retryUntil.delete(t.id);

    tasks.touchPoll(t.id);

    // 状态映射：真实接口除 queued/in_progress/completed/failed 外还可能返回
    // pending（排队等待中）等状态 —— 一律视为“等待中”，绝不能误判为失败
    let finalStatus;
    if (status === 'completed' || status === 'failed') {
      finalStatus = status;
    } else if (status === 'pending' || status === 'processing' || status === 'running') {
      finalStatus = 'queued';
    } else if (status === 'queued' || status === 'in_progress') {
      finalStatus = status;
    } else {
      log('warn', `任务 #${t.id} 返回未知状态 "${status}"，按 queued 继续轮询`);
      finalStatus = 'queued';
    }

    tasks.setPollResult(t.id, {
      status: finalStatus,
      progress,
      completed_at: j.completed_at !== undefined && j.completed_at !== null ? Number(j.completed_at) : null,
      last_poll_response: j,
      metadata_url: metadataUrl,
      error_message: status === 'failed' ? (errorMessage || '生成失败（未知错误）') : null,
    });

    if (status === 'completed') {
      log('info', `任务 #${t.id} 完成，视频地址: ${metadataUrl}`);
    } else if (status === 'failed') {
      log('error', `任务 #${t.id} 失败: ${errorMessage || '未知错误'}`);
    }
  }

  /** 指数退避：下次轮询时间 = now + min(2^次数 * base, CAP) */
  backoff(taskId, baseMs = 2000) {
    const prev = this.retryUntil.get(taskId);
    const attempts = prev ? prev.attempts + 1 : 1;
    const delay = Math.min(baseMs * Math.pow(2, attempts - 1), RETRY_CAP_MS);
    this.retryUntil.set(taskId, { until: Date.now() + delay, attempts });
  }

  /** 立即强制轮询某个任务（返回最新状态字符串，供 API 使用） */
  async pollNow(taskId) {
    const t = tasks.get(taskId);
    if (!t) throw new Error('任务不存在');
    if (!t.video_id) throw new Error('该任务尚未获得 video_id，无法查询（请先重试）');
    this.retryUntil.delete(t.id);
    await this.pollOne(t);
    return (tasks.get(taskId) || {}).status;
  }
}

module.exports = new Poller();