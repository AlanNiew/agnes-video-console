'use strict';
/**
 * submitter.js —— 后台提交器（v1.3）
 * 接管「已入队但尚未提交上游」的任务（queued 且无 video_id）：
 * - 按模型串行提交，最小间隔由设置 submit_interval_ms 控制（服务端强制，
 *   根治上游「1 次/分钟」限流导致批量提交撞 429 的问题）
 * - 429 / 网络错误 / 5xx 自动指数退避重试，重试耗尽才落 submit_error
 * - 其余 4xx（鉴权/参数等）不可恢复，直接 submit_error
 */
const { settings, tasks, DEFAULT_SETTINGS } = require('../db');
const { instanceLockHeldByOther } = require('../instance-lock');
const agnes = require('../clients/agnes');
const dreamina = require('../clients/dreamina');
const { downloadArtifact, ARTIFACTS_DIR } = require('../lib/artifacts');
const path = require('node:path');
const fs = require('node:fs');
const { log } = require('../core/logger');
const { DEFAULT_BASE_URL } = require('../core/config');
const { providerOf, DREAMINA_FALLBACK_VIDEO_MODEL } = require('../core/constants');
const { dreaminaToAgnes, agnesToDreamina, estimateDreaminaCost } = require('../services/payloads');
const {
  shouldFallbackFromDreamina,
  shouldFallbackToDreamina,
  dreaminaUsable,
  fallbackReasonText,
  toDreaminaReasonText,
} = require('../core/provider-policy');

/**
 * v2.6.7 反向回退用的即梦账户状态缓存（60s）：
 * `dreamina.credit()` 要 spawn CLI（实测约 1s），而一次失败可能触发多次判断，故缓存而非每次都问。
 */
let dmStatusCache = { at: 0, data: null };
async function cachedDreaminaStatus(ttlMs = 60_000) {
  if (dmStatusCache.data && Date.now() - dmStatusCache.at < ttlMs) return dmStatusCache.data;
  let data;
  try {
    const r = await dreamina.credit();
    data = r?.ok ? r.data : null;
  } catch {
    data = null;
  }
  dmStatusCache = { at: Date.now(), data };
  return data;
}

/**
 * 即梦 CLI 的 `--image` 只接受**本地文件路径**（官方 help 原文「local first-frame image path」）。
 * 本系统的首帧图通常是远端 URL（Agnes/即梦产物）或 `/artifacts/xxx` 相对路径，故提交前需落到本地。
 * @returns {Promise<string|null>} 本地绝对路径；null 表示无法取得（调用方据此给出可读错误）
 */
async function ensureLocalImage(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // 1) 已是绝对路径
  if (path.isAbsolute(s)) return fs.existsSync(s) ? s : null;
  // 2) 本地产物相对路径（前端展示用的 /artifacts/xxx）
  if (s.startsWith('/artifacts/')) {
    const abs = path.join(ARTIFACTS_DIR, s.slice('/artifacts/'.length));
    return fs.existsSync(abs) ? abs : null;
  }
  // 3) 远端 URL → 下载归档后取本地路径
  if (/^https?:\/\//i.test(s)) {
    const art = await downloadArtifact(s, { fallbackExt: '.png' });
    return art?.local_path || null;
  }
  return null;
}

const TICK_MS = 1000;
const MAX_ATTEMPTS = 5;
// 429 首次退避基数：默认 60s（对齐免费档 1 次/分钟）；测试可用 SUBMIT_RATE_LIMIT_BASE_MS 覆盖
const RATE_LIMIT_BASE_MS = Math.max(Number(process.env.SUBMIT_RATE_LIMIT_BASE_MS) || 60_000, 1_000);
const RATE_LIMIT_CAP_MS = Number(process.env.SUBMIT_RATE_LIMIT_BASE_MS)
  ? Math.max(RATE_LIMIT_BASE_MS * 8, 10_000)
  : 10 * 60_000;
const NET_BASE_MS = 10_000;
const NET_CAP_MS = 60_000;
// 上游「队列满」（video_queue_full / 503）用分钟级耐心退避：秒级档位会在一两分钟内耗尽重试次数，
// 等于对着同一堵墙反复撞（E05 实测：503 持续数分钟，秒级退避 4 次全废）
const QUEUE_BASE_MS = 90_000;
const QUEUE_CAP_MS = 15 * 60_000;
// 即梦（CLI）环境未就绪（未安装 / 未登录）时的退避：属环境问题而非任务自身错误，
// 保留 queued 待人工处理后自动续跑，避免每 tick 反复 spawn 探测
const DREAMINA_ENV_BACKOFF_MS = 5 * 60_000;

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

/**
 * 退避延迟计算（指数退避 + 上限）
 * @param {number} attempts 重试次数（从 1 起）
 * @param {'rate-limit'|'net'|'queue'} kind 429 限流 / 网络异常 / 上游队列满（各自基数与上限）
 */
function computeBackoffMs(attempts, kind) {
  if (kind === 'queue') return Math.min(QUEUE_BASE_MS * 2 ** (attempts - 1), QUEUE_CAP_MS);
  if (kind === 'net') return Math.min(NET_BASE_MS * 2 ** (attempts - 1), NET_CAP_MS);
  return Math.min(RATE_LIMIT_BASE_MS * 2 ** (attempts - 1), RATE_LIMIT_CAP_MS);
}

/** 上游错误详情：优先 detail / error.message；503 无正文时给可读提示（队列繁忙），避免出现「提交失败（503）：」 */
function serverDetail(r) {
  const d = r?.data?.detail || r?.data?.error?.message || r?.data?.error || '';
  const text = String(typeof d === 'string' ? d : d ? JSON.stringify(d) : '').trim();
  if (text) return text.slice(0, 300);
  return r?.status === 503 ? '上游队列繁忙（503，生成额度排队），稍后自动重试' : '上游服务异常';
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
        const isDreamina = providerOf(t.model) === 'dreamina';
        const last = this.lastSubmitAt.get(t.model) || 0;
        // 即梦为队列制作业（提交即排队，无 429 限流），不套用 Agnes 免费档的「提交间隔」节流
        if (!isDreamina && interval > 0 && Date.now() - last < interval) continue; // 模型间隔未到
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

  /**
   * 该任务**是否允许**再回退到 Agnes（防 v2.6.7 反向回退引入的「来回弹」死循环）。
   *
   * 反向回退会把 Agnes 失败任务原地改成即梦（error_message 记为「已改投即梦（…）」）。
   * 若这类任务在即梦侧再失败又回退 Agnes，就会无限循环：Agnes 503 → 即梦 → 回退 Agnes → 503 → …
   * 判据用**持久化的 error_message 前缀**（重启后依然有效），而不是内存态，进程重启也不会失效。
   *
   * @returns {boolean} true=允许回退免费档；false=该任务已经是从 Agnes 改投来的，禁止再弹回去
   */
  canFallbackToAgnes(t) {
    return !String(t.error_message || '').startsWith('已改投即梦');
  }

  /**
   * v2.6.1 即梦视频不可用 / 失败 → **改投免费档（Agnes）**。
   *
   * 命中条件（core/provider-policy.js）：积分不足 / 生成失败 / 非 VIP / 环境未就绪 / 合规闸门 / 首帧取不到本地文件。
   * 原地改写任务行（model + request_json + 清掉即梦 submit_id 与退避），状态回到 queued，
   * 下一轮 tick 由 Agnes HTTP 路径提交——不新增状态、不新增路由。
   *
   * @returns {boolean} true=已改投（调用方直接 return）；false=未改投（调用方按原逻辑处理）
   */
  fallbackDreaminaVideo(t, reason) {
    if (settings.get('dreamina_fallback', DEFAULT_SETTINGS.dreamina_fallback) !== '1') return false;
    const why = fallbackReasonText(reason);
    const mapped = dreaminaToAgnes('video', t);
    if (!mapped) {
      log('warn', `任务 #${t.id} ${why}，但没有可映射的提示词，无法改投免费档`);
      return false;
    }
    if (!settings.get('api_key', '')) {
      log('warn', `任务 #${t.id} ${why}，但未配置 Agnes API Key，回退路径不可用`);
      return false;
    }
    this.retryUntil.delete(t.id);
    tasks.update(t.id, {
      model: mapped.model,
      seconds: mapped.seconds,
      size: mapped.size,
      aspect_ratio: mapped.aspect_ratio,
      request_json: mapped.request_json,
      status: 'queued',
      progress: 0,
      task_id: null, // 清掉即梦 submit_id
      video_id: null, // poller 靠它判定「已提交」，必须清空才会走 Agnes 轮询
      submit_response: null,
      error_message: `已回退免费档（${why}${mapped.notes.length ? '；' + mapped.notes.join('；') : ''}）`,
    });
    log(
      'warn',
      `任务 #${t.id} ${why} → 改投免费档 ${mapped.model}（创意提示词不变${mapped.notes.length ? '；' + mapped.notes.join('；') : ''}），继续制作`,
    );
    return true;
  }

  /**
   * 即梦分支的「瞬时错误退避重试 → 重试耗尽改投免费档」统一入口。
   * @returns {boolean} 恒为 true（本轮已处理）
   */
  backoffDreaminaOrFallback(t, detail, kind, attempts) {
    const decision = shouldFallbackFromDreamina(kind, { attempts, maxAttempts: MAX_ATTEMPTS });
    if (decision.fallback && this.fallbackDreaminaVideo(t, kind)) return true;
    this.backoff(t.id, computeBackoffMs(attempts, 'net'), attempts);
    log('warn', `任务 #${t.id} 即梦提交异常（第 ${attempts} 次，${kind}）：${detail}`);
    return true;
  }

  /**
   * v2.6.7 **反向回退**：Agnes（免费档）提交失败 → **改投即梦**继续制作。
   *
   * 为什么需要：flash 免费档队列满时会连续 503，重试预算（约 22 分钟）耗尽即落 submit_error，
   * 无人值守时会一直卡住。此时改投即梦（默认 `seedance2.0mini`，实测队列空闲时 150 秒出片）
   * 就能把制作走完 —— 代价是消耗会员积分（5s/720p ≈ 30 积分），故设置项默认关闭。
   *
   * 命中条件：设置项 `dreamina_agnes_fallback='1'` 且
   *   ① 失败类型属"重试也大概率无效"（queue-full / rate-limit / net）；
   *   ② 任务可映射（有提示词、**不带参考图** —— 语义不同不改投）；
   *   ③ 即梦环境可用（已安装 + 已登录 + 有权益）且**积分够**（按护栏预估算）。
   *
   * 动作与 `fallbackDreaminaVideo` 对称：原地改写任务行（model + request_json + 清 submit_id），
   * 状态回 queued，下一轮 tick 由即梦 CLI 路径提交；不新增状态、不新增路由。
   *
   * @returns {Promise<boolean>} true=已改投（调用方直接 return）
   */
  async fallbackAgnesVideoToDreamina(t, kind) {
    const enabled = settings.get('dreamina_agnes_fallback', DEFAULT_SETTINGS.dreamina_agnes_fallback) === '1';
    const decision = shouldFallbackToDreamina(kind, { enabled });
    if (!decision.fallback) return false;

    const mapped = agnesToDreamina(t, DREAMINA_FALLBACK_VIDEO_MODEL);
    if (!mapped.ok) {
      log(
        'warn',
        `任务 #${t.id} ${toDreaminaReasonText(kind)}，但${toDreaminaReasonText(mapped.reason)}，保持失败状态等人工`,
      );
      return false;
    }

    // 环境 + 积分护栏：任何一项不满足就不改投（宁可失败，也不盲目花积分）
    const status = await cachedDreaminaStatus();
    const usable = dreaminaUsable({
      installed: dreamina.isInstalled(),
      loggedIn: !!status,
      vipLevel: status?.vip_level,
      enabled: true,
    });
    if (!usable.usable) {
      log('warn', `任务 #${t.id} ${toDreaminaReasonText(kind)}，但无法改投即梦：${fallbackReasonText(usable.reason)}`);
      return false;
    }
    const est = estimateDreaminaCost(mapped.model, {
      video_resolution: mapped.size,
      duration: Number(mapped.seconds),
    });
    const credits = Number(status?.total_credit);
    if (est && est.points != null && Number.isFinite(credits) && credits < est.points) {
      log('warn', `任务 #${t.id} 无法改投即梦：积分不足（需约 ${est.points}，余 ${credits}）`);
      return false;
    }

    const note = mapped.notes.length ? `；${mapped.notes.join('；')}` : '';
    this.retryUntil.delete(t.id);
    tasks.update(t.id, {
      model: mapped.model,
      seconds: mapped.seconds,
      size: mapped.size,
      aspect_ratio: mapped.aspect_ratio,
      request_json: mapped.request_json,
      status: 'queued',
      progress: 0,
      task_id: null,
      video_id: null,
      submit_response: null,
      error_message: `已改投即梦（${toDreaminaReasonText(kind)}${note}）`,
    });
    log(
      'warn',
      `任务 #${t.id} ${toDreaminaReasonText(kind)} → 改投即梦 ${mapped.model}` +
        `（约 ${est?.points ?? '?'} 积分，余 ${Number.isFinite(credits) ? credits : '?'}；创意提示词不变${note}），继续制作`,
    );
    return true;
  }

  async submitOne(t) {
    // provider 分流：即梦走本地 CLI（无 apiKey 概念，登录态由 CLI 保管），Agnes 走 HTTP
    if (providerOf(t.model) === 'dreamina') {
      await this.submitDreamina(t);
      return;
    }
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
        // v2.6.7：重试耗尽 → 先试反向回退（改投即梦），不行才落 submit_error
        if (await this.fallbackAgnesVideoToDreamina(t, 'net')) return;
        this.fail(t.id, `提交网络异常（自动重试 ${attempts - 1} 次）：${e.message}`);
        return;
      }
      this.backoff(t.id, computeBackoffMs(attempts, 'net'), attempts);
      log('warn', `任务 #${t.id} 提交网络异常（第 ${attempts} 次）：${e.message}`);
      return;
    }

    if (r.status === 429) {
      if (attempts >= MAX_ATTEMPTS) {
        if (await this.fallbackAgnesVideoToDreamina(t, 'rate-limit')) return;
        this.fail(t.id, `提交限流（429），自动重试 ${attempts - 1} 次后仍失败：请降低提交频率，稍后再试`, r.data);
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

    // 5xx（上游队列满 503 / 网关抖动等）属瞬时错误：退避重试，不再秒判死。
    // 历史缺陷：除 429 外一律 fail，导致 video_queue_full 直接把任务打成 submit_error（E03 重拍实测）
    if (r.status >= 500) {
      const queueFull = /queue_full|queue is full|队列/i.test(JSON.stringify(r.data || ''));
      if (attempts >= MAX_ATTEMPTS) {
        // v2.6.7：队列满/5xx 重试耗尽 → 反向回退即梦（正是 flash 长期 503 的场景）
        if (await this.fallbackAgnesVideoToDreamina(t, queueFull ? 'queue-full' : 'net')) return;
        this.fail(t.id, `提交失败（${r.status}），自动重试 ${attempts - 1} 次后仍失败：${serverDetail(r)}`, r.data);
        return;
      }
      const delay = computeBackoffMs(attempts, queueFull ? 'queue' : 'net');
      this.backoff(t.id, delay, attempts);
      log(
        'warn',
        `任务 #${t.id} 上游返回 ${r.status}（${queueFull ? '队列满，分钟级耐心重试' : '瞬时错误'}，${serverDetail(r)}），` +
          `${Math.round(delay / 1000)}s 后自动重试（${attempts}/${MAX_ATTEMPTS}）`,
      );
      return;
    }

    if (!r.ok) {
      const detail = r.data?.detail || r.data?.error?.message || '';
      this.fail(t.id, `提交失败（${r.status}）：${String(detail).slice(0, 300)}`, r.data);
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

  /**
   * 即梦（官方 dreamina CLI）提交。
   * 与 Agnes 的差异：无 apiKey（登录态由 CLI 本地保管，本层不感知凭证）；
   * 返回 submit_id（UUID）而非 video_id；状态语义为 gen_status（querying/success/fail）而非 status。
   * submit_id 存入 video_id 字段：poller 的 active() 靠 video_id 非空判定「已提交」，复用即零 schema 变更。
   */
  async submitDreamina(t) {
    if (!t.request_json) {
      this.fail(t.id, '任务缺少 request_json（历史数据异常），无法提交');
      return;
    }
    // 浅拷贝一份：image / images 需替换为本地路径（即梦 CLI 的 --image 只接受本地文件），
    // 不污染库中保存的原始请求（升级 / 重试可能复用同一份）
    const payload = { ...t.request_json };
    if (payload.image) {
      const local = await ensureLocalImage(payload.image);
      if (!local) {
        // v2.6.1：即梦 CLI 只吃本地首帧 —— Agnes 可直接引用远端 URL，故改投免费档而不是判死
        if (this.canFallbackToAgnes(t) && this.fallbackDreaminaVideo(t, 'bad-args')) return;
        this.fail(
          t.id,
          `首帧图无法落到本地（即梦 CLI 的 --image 只接受本地文件）：${String(payload.image).slice(0, 120)}`,
        );
        return;
      }
      payload.image = local;
    }
    // 全能参考（multimodal2video）的参考图同样必须是本地路径，逐张落地；
    // 任何一张取不到就整单不走即梦（静默丢图 = "参考了却不生效"，比失败更难排查）
    if (Array.isArray(payload.images) && payload.images.length) {
      const locals = [];
      for (const src of payload.images) {
        const local = await ensureLocalImage(src);
        if (!local) {
          const msg = `参考图无法落到本地（即梦 CLI 的 --image 只接受本地文件）：${String(src).slice(0, 120)}`;
          if (this.canFallbackToAgnes(t) && this.fallbackDreaminaVideo(t, 'bad-args')) return;
          this.fail(t.id, msg);
          return;
        }
        locals.push(local);
      }
      payload.images = locals;
    }
    const prev = this.retryUntil.get(t.id);
    const attempts = prev ? prev.attempts + 1 : 1;

    let r;
    try {
      r = await dreamina.submitVideo(payload);
    } catch (e) {
      if (attempts >= MAX_ATTEMPTS) {
        // v2.6.1：重试耗尽 → 改投免费档，而不是把制作卡死
        // v2.6.7：若该任务已是从 Agnes 改投来的，禁止再弹回（防来回死循环）
        if (this.canFallbackToAgnes(t) && this.fallbackDreaminaVideo(t, 'spawn-error')) return;
        this.fail(t.id, `即梦提交异常（自动重试 ${attempts - 1} 次）：${e.message}`);
        return;
      }
      this.backoff(t.id, computeBackoffMs(attempts, 'net'), attempts);
      log('warn', `任务 #${t.id} 即梦提交异常（第 ${attempts} 次）：${e.message}`);
      return;
    }

    if (!r.ok) {
      // 环境 / 合规未就绪：非任务自身错误，保留 queued 等人工处理（安装 CLI、完成登录、
      // 去 Web 端做首次生成确认）后自动续跑，绝不直接判死。
      // need-web-confirm 对应 AigcComplianceConfirmationRequired —— 官方文档明确：
      // 为满足合规要求，视频必须先到即梦 Web 端用该模型完成一次生成，CLI 才允许提交。
      if (r.kind === 'not-installed' || r.kind === 'not-logged-in' || r.kind === 'need-web-confirm') {
        // v2.6.1：环境/合规不可用 → 优先改投免费档（台账 §七 规则 4：合规闸门「不等它」）
        // v2.6.7：已从 Agnes 改投来的任务不再弹回（防死循环），直接退避等环境恢复
        if (this.canFallbackToAgnes(t) && this.fallbackDreaminaVideo(t, r.kind)) return;
        this.backoff(t.id, DREAMINA_ENV_BACKOFF_MS, attempts);
        const reason =
          r.kind === 'need-web-confirm'
            ? '即梦要求先到 Web 端用该模型完成一次生成（合规确认）'
            : `即梦环境未就绪（${r.kind}）`;
        log(
          'warn',
          `任务 #${t.id} ${reason}，保留入队，` +
            `${Math.round(DREAMINA_ENV_BACKOFF_MS / 60000)} 分钟后重试：${r.error}`,
        );
        return;
      }
      // 超时 / 进程异常：瞬时错误，退避重试
      if (r.kind === 'timeout' || r.kind === 'spawn-error') {
        return this.backoffDreaminaOrFallback(t, r.error, r.kind, attempts);
      }
      // 参数错误 / CLI 业务错误（含积分不足）：v2.6.1 先尝试改投免费档，改投不了才判失败
      if (this.canFallbackToAgnes(t) && this.fallbackDreaminaVideo(t, r.kind)) return;
      this.fail(t.id, `即梦提交失败：${r.error || r.kind}`, r.data);
      return;
    }

    const j = r.data || {};
    const submitId = j.submit_id || null;
    if (!submitId) {
      // v2.6.1：拿不到 submit_id 说明即梦侧没有可追踪的任务 → 改投免费档重做
      if (this.canFallbackToAgnes(t) && this.fallbackDreaminaVideo(t, 'no-result')) return;
      this.fail(t.id, '即梦提交未返回 submit_id，无法追踪任务', j);
      return;
    }
    this.lastSubmitAt.set(t.model, Date.now());
    this.retryUntil.delete(t.id);
    tasks.update(t.id, {
      task_id: submitId,
      video_id: submitId, // 复用 video_id 字段承载 submit_id（poller 依赖它判定「已提交」）
      submit_response: j,
      status: 'queued', // gen_status=querying 表示已受理，后续由 poller 轮询推进
      progress: 0,
      submitted_at: Date.now(),
    });
    const q = j.queue_info || {};
    log(
      'info',
      `任务 #${t.id} 即梦提交成功 submit_id=${submitId} ` +
        `队列=${q.queue_idx ?? '?'}/${q.queue_length ?? '?'} 扣积分=${j.credit_count ?? '?'}`,
    );
  }
}

module.exports = new Submitter();
// 纯函数与常量导出（供单元测试断言退避数学；submitter 单例仍为默认导出）
module.exports.computeBackoffMs = computeBackoffMs;
