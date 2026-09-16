'use strict';
/**
 * poller.js —— 后台轮询器
 * 每隔 poll_interval_ms 轮询所有进行中（queued / in_progress）任务；
 * 429 / 网络错误按指数退避；超过 max_active_minutes 的任务标记为失败（轮询超时）。
 * v1.3：完成视频自动归档到本地（artifacts.js）；「待提交任务」由 submitter.js 接管。
 */
const { settings, tasks } = require('../db');
const { instanceLockHeldByOther } = require('../instance-lock');
const agnes = require('../clients/agnes');
const dreamina = require('../clients/dreamina');
const { downloadArtifact } = require('../lib/artifacts');
const { log } = require('../core/logger');
const { DEFAULT_BASE_URL } = require('../core/config');
const { providerOf } = require('../core/constants');

const RETRY_CAP_MS = 60_000; // 单任务退避上限 60s
// v2.3 视频归档下载失败后的自动重试节奏（30s / 2min / 10min，共 3 次）
const ARCHIVE_RETRY_MS = [30_000, 120_000, 600_000];

class Poller {
  constructor() {
    this.timer = null;
    this.running = false;
    this.pollingIds = new Set(); // 正在轮询的任务 id（防止定时 tick 与手动 pollNow 并发轮询同一任务）
    this.retryUntil = new Map(); // taskId -> 允许再次轮询的时间戳
    this.pendingArchive = new Map(); // taskId -> {attempt, at}：视频归档失败待重试
    this.archiveBusy = false;
  }

  start() {
    this.stop();
    const interval = Math.max(Number(settings.get('poll_interval_ms', 2000)) || 2000, 500);
    this.timer = setInterval(() => this.tick().catch((e) => log('error', `轮询循环异常: ${e.message}`)), interval);
    this.timer.unref?.();
    log('info', `轮询器已启动，间隔 ${interval}ms`);
    // 启动补扫：为历史已完成但未归档的任务补齐本地视频（后台执行，不阻塞启动）
    setTimeout(() => this.sweepArchives().catch((e) => log('error', `归档补扫异常: ${e.message}`)), 3000).unref?.();
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
    if (instanceLockHeldByOther()) return; // v1.6.1 工作锁：本实例非持有者时不工作
    this.running = true;
    try {
      // 轮询进行中的任务（待提交任务由 submitter.js 接管，见 active() 的 video_id 过滤）
      const active = tasks.active();
      for (const t of active) {
        const due = this.retryUntil.get(t.id);
        if (due && due.until > Date.now()) continue; // 退避中
        await this.pollOne(t);
      }
    } finally {
      this.running = false;
    }
    await this.tickArchives(); // v2.3：顺带处理归档失败的自动重试
  }

  /** v2.3 视频自动下载是否开启（设置项，动态生效） */
  autoArchive() {
    return settings.get('video_auto_download', '0') === '1';
  }

  /** 下载归档单个视频到本地；成功写 video_local_path 并返回 true */
  async downloadAndArchive(t, url) {
    const target = String(url || t?.metadata_url || '').trim();
    if (!target || t.video_local_path) return true;
    const art = await downloadArtifact(target, { fallbackExt: '.mp4' });
    if (art) {
      tasks.update(t.id, { video_local_path: art.local_path });
      log('info', `任务 #${t.id} 视频已本地归档: ${art.local_path}`);
      return true;
    }
    return false;
  }

  /** 归档失败自动重试队列：每次 tick 至多处理一个到期项，避免并发下载 */
  async tickArchives() {
    if (this.archiveBusy || !this.pendingArchive.size) return;
    const now = Date.now();
    for (const [id, e] of this.pendingArchive) {
      if (e.at > now) continue;
      const t = tasks.get(id);
      if (!t || t.video_local_path) {
        this.pendingArchive.delete(id);
        continue;
      }
      this.archiveBusy = true;
      try {
        const ok = await this.downloadAndArchive(t);
        if (ok) this.pendingArchive.delete(id);
        else this.scheduleArchiveRetry(id);
      } finally {
        this.archiveBusy = false;
      }
      return;
    }
  }

  scheduleArchiveRetry(taskId) {
    const cur = this.pendingArchive.get(taskId);
    const attempt = (cur ? cur.attempt : 0) + 1;
    if (attempt > ARCHIVE_RETRY_MS.length) {
      this.pendingArchive.delete(taskId);
      log('warn', `任务 #${taskId} 视频归档多次重试仍失败，暂留缺失（可稍后重启触发补扫）`);
      return;
    }
    const waitMs = ARCHIVE_RETRY_MS[attempt - 1];
    this.pendingArchive.set(taskId, { attempt, at: Date.now() + waitMs });
    log(
      'warn',
      `任务 #${taskId} 视频归档失败，${Math.round(waitMs / 1000)}s 后自动重试（${attempt}/${ARCHIVE_RETRY_MS.length}）`,
    );
  }

  /** v1.3 归档补扫：为历史 completed 任务补齐本地视频（顺序 + 500ms 限速，失败不阻塞）。
   * v2.3 受 video_auto_download 开关控制：默认关闭时跳过，避免自动把海量历史下载下来占盘 */
  async sweepArchives() {
    if (!this.autoArchive()) {
      log('info', '归档补扫跳过：视频自动下载未开启（在「设置」开启后重启本服务即可补扫历史任务）');
      return;
    }
    const pending = tasks.completedWithoutLocal();
    if (!pending.length) return;
    log('info', `归档补扫：发现 ${pending.length} 个已完成任务未本地归档，开始下载`);
    let ok = 0;
    for (const t of pending) {
      const art = await downloadArtifact(t.metadata_url, { fallbackExt: '.mp4' });
      if (art) {
        tasks.update(t.id, { video_local_path: art.local_path });
        ok += 1;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    log('info', `归档补扫完成：成功 ${ok}/${pending.length}`);
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
    // v1.9.2 快照防陈旧：长 tick 进行中，手动 pollNow 可能已把该任务推到终态——
    // 以最新状态为准，终态直接跳过（防止超时分支把 completed 改判 failed、或重复归档下载）
    const fresh = tasks.get(t.id);
    if (!fresh) return;
    if (fresh.status === 'completed') {
      // v2.3：对已完成的视频，手动「立即查询」也可在开关开启时补齐本地归档（此前终态直接跳过，补下无门）
      if (this.autoArchive() && !fresh.video_local_path && fresh.metadata_url) {
        const ok = await this.downloadAndArchive(fresh);
        if (!ok) this.scheduleArchiveRetry(fresh.id);
      }
      return;
    }
    if (['failed', 'submit_error'].includes(fresh.status)) return;
    t = fresh;

    // provider 分流：即梦的鉴权、状态语义与超时策略都与 Agnes 不同，走独立分支
    if (providerOf(t.model) === 'dreamina') {
      await this.pollDreamina(t);
      return;
    }

    const apiKey = settings.get('api_key', '');
    const baseUrl = settings.get('base_url', DEFAULT_BASE_URL);
    const maxActiveMs = Math.max((Number(settings.get('max_active_minutes', 20)) || 20) * 60_000, 30_000);

    // 轮询超时保护：实际提交（或创建）超过 max_active_minutes 仍未结束
    // （提交队列下任务可能在队列中等待限流放行，因此以 submitted_at 为基准；
    //   completed/failed 已是终态，手动「立即查询」不应再把它们翻成失败）
    const activeBase = t.submitted_at || t.created_at;
    if (t.status !== 'completed' && t.status !== 'failed' && Date.now() - activeBase > maxActiveMs) {
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
            error_message: 'video_id 不存在（404）：该视频可能已被上游删除或从未创建成功',
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
            const msg = r.data?.error?.message || `上游返回 HTTP ${r.status}`;
            tasks.setPollResult(t.id, {
              status: 'failed',
              last_poll_response: r.data,
              error_message: `查询失败（${r.status}）：${String(msg).slice(0, 300)}`,
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
      error_message: status === 'failed' ? errorMessage || '生成失败（未知错误）' : null,
    });

    if (status === 'completed') {
      log('info', `任务 #${t.id} 完成，视频地址: ${metadataUrl}`);
      // v1.3 归档：完成即下载到本地（平台远端链接会过期）。v2.3 起受 video_auto_download 开关控制，
      // 默认关闭（省磁盘，仅保留平台链接）；失败进入自动重试队列，超限后留待重启补扫兜底。
      if (metadataUrl && !t.video_local_path) {
        if (this.autoArchive()) {
          const ok = await this.downloadAndArchive(t, metadataUrl);
          if (!ok) this.scheduleArchiveRetry(t.id);
        } else {
          log('info', `任务 #${t.id} 完成（自动下载已关闭，仅保留平台链接；需要本地备份请在「设置」开启）`);
        }
      }
    } else if (status === 'failed') {
      log('error', `任务 #${t.id} 失败: ${errorMessage || '未知错误'}`);
    }
  }

  /**
   * 即梦（官方 dreamina CLI）轮询：query_result --submit_id=<uuid>。
   * 与 Agnes 的差异：
   *   - 无 apiKey：登录态由 CLI 本地保管，未登录/未安装时保留状态等人工处理，绝不误判为任务失败
   *   - 状态语义为 gen_status（querying / success / fail），需映射到本系统的四态枚举
   *   - 队列排队极长（实测 queue_length 达数十万），超时阈值改用独立的 dreamina_max_active_minutes
   */
  async pollDreamina(t) {
    const maxActiveMs = Math.max((Number(settings.get('dreamina_max_active_minutes', 720)) || 720) * 60_000, 60_000);
    const activeBase = t.submitted_at || t.created_at;
    if (Date.now() - activeBase > maxActiveMs) {
      this.retryUntil.delete(t.id);
      tasks.setPollResult(t.id, {
        status: 'failed',
        progress: t.progress,
        last_poll_response: t.last_poll_response,
        error_message: `即梦轮询超时（超过 ${Math.round(maxActiveMs / 60000)} 分钟未完成；即梦队列排队可能极长）`,
      });
      log('warn', `任务 #${t.id} (${t.video_id}) 即梦轮询超时 → failed`);
      return;
    }

    let r;
    try {
      r = await dreamina.queryResult({ submitId: t.video_id });
    } catch (e) {
      this.backoff(t.id, 5000);
      log('error', `任务 #${t.id} (${t.video_id}) 即梦查询异常: ${e.message}`);
      return;
    }

    if (!r.ok) {
      // 环境未就绪：非任务自身错误，保留状态等人工处理后自动续跑
      if (r.kind === 'not-installed' || r.kind === 'not-logged-in') {
        this.backoff(t.id, 5 * 60_000);
        log('warn', `任务 #${t.id} 即梦环境未就绪（${r.kind}），暂停轮询：${r.error}`);
        return;
      }
      // 瞬时错误：退避重试
      if (r.kind === 'timeout' || r.kind === 'spawn-error') {
        this.backoff(t.id, 3000);
        log('warn', `任务 #${t.id} 即梦查询异常（${r.kind}），稍后重试：${r.error}`);
        return;
      }
      // 其余（submit_id 不存在 / 任务已过期等）：不可恢复，标记失败
      tasks.setPollResult(t.id, {
        status: 'failed',
        last_poll_response: r.data,
        error_message: `即梦查询失败：${String(r.error || r.kind).slice(0, 300)}`,
      });
      log('error', `任务 #${t.id} 即梦查询失败（${r.kind}）→ failed: ${r.error}`);
      return;
    }

    const j = r.data || {};
    const genStatus = String(j.gen_status || '');
    // gen_status: querying（排队 / 生成中）/ success / fail
    let finalStatus;
    if (genStatus === 'success') finalStatus = 'completed';
    else if (genStatus === 'fail' || genStatus === 'failed') finalStatus = 'failed';
    else if (genStatus === 'querying') finalStatus = 'in_progress';
    else {
      log('warn', `任务 #${t.id} 返回未知 gen_status "${genStatus}"，按 queued 继续轮询`);
      finalStatus = 'queued';
    }

    // 产物地址字段尚未实测确认（CLI 亦支持 --download_dir 直接落盘），故兼容常见字段名
    const rawUrl = j.video_url || j.url || j.metadata?.url || j.data?.video_url || null;
    const metadataUrl = typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : null;

    this.retryUntil.delete(t.id);
    tasks.touchPoll(t.id);
    tasks.setPollResult(t.id, {
      status: finalStatus,
      progress: finalStatus === 'completed' ? 100 : t.progress,
      last_poll_response: j,
      metadata_url: metadataUrl,
      error_message: finalStatus === 'failed' ? String(j.fail_reason || j.error || '即梦生成失败').slice(0, 300) : null,
    });

    if (finalStatus === 'completed') {
      const hint = metadataUrl ? metadataUrl : '(上游未返回 url，可能需改用 --download_dir 模式)';
      log('info', `任务 #${t.id} 即梦生成完成，视频地址: ${hint}`);
      if (metadataUrl && !t.video_local_path) {
        if (this.autoArchive()) {
          const ok = await this.downloadAndArchive(t, metadataUrl);
          if (!ok) this.scheduleArchiveRetry(t.id);
        } else {
          log('info', `任务 #${t.id} 完成（自动下载已关闭，仅保留平台链接）`);
        }
      }
    } else if (finalStatus === 'failed') {
      log('error', `任务 #${t.id} 即梦生成失败: ${j.fail_reason || j.error || '未知原因'}`);
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
