'use strict';
/**
 * image-worker.js —— 图片任务后台工作器（P1：图片任务统一进任务体系）
 * 接管 kind='image' 且 queued 的任务：
 * - 串行执行同步上游图片生成（多张时并行请求、部分失败不阻塞成功者）
 * - 完成后逐张归档产物；挂项目的任务落 project_images 并首张自动定稿（与 /api/images/generate 行为一致）
 * - 429 / 网络错误 / 5xx 指数退避重试，耗尽才落 failed；其余错误直接 failed
 * - 单实例工作锁持有者才运行（与 submitter / poller / renderer 一致）
 */
const { settings, tasks, projects, DEFAULT_SETTINGS } = require('../db');
const { instanceLockHeldByOther } = require('../instance-lock');
const agnes = require('../clients/agnes');
const { downloadArtifact } = require('../lib/artifacts');
const { log } = require('../core/logger');
const { IMAGE_MODEL } = require('../core/constants');
const { safeUrl } = require('../services/payloads');

const TICK_MS = 5000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000; // 429/网络错误首次退避基数
const RETRY_CAP_MS = 5 * 60_000;

function computeBackoffMs(attempts) {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS);
}

/** 归档下载重试（3 次）：图片侧没有像视频那样的补扫兜底，单次失败就会让 local_path 永久为 null；
 * 而渲染片头/片尾卡的背景图依赖它（缺失时被迫读远端 URL → 弱网下渲染卡死，v2.5 实测）。 */
async function downloadWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const art = await downloadArtifact(url).catch(() => null);
    if (art) return art;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  return null;
}

class ImageWorker {
  constructor() {
    this.timer = null;
    this.running = false;
    this.sweepDone = false; // v2.5.2 归档补扫每进程仅跑一次
    this.retryUntil = new Map(); // taskId -> { until, attempts }（内存态：进程重启即重来，可接受）
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) => log('error', `图片任务循环异常: ${e.message}`)), TICK_MS);
    this.timer.unref?.();
    log('info', '图片任务工作器已启动（串行生成，产物统一进任务中心）');
    // v2.5.2：启动时补扫历史图片任务缺失的本地备份（图片侧此前无兜底，失败即永久缺失）
    this.sweepArchives().catch((e) => log('warn', `图片归档补扫异常：${e.message}`));
  }

  /** v2.5.2 归档补扫：为已完成但缺本地备份的图片任务重新下载（逐张重试），
   *  靶子选 project_images.local_path 而不是任务行 —— 后者已被 poller 的视频补扫顺带覆盖（不区分 kind），
   *  而渲染的片头/片尾卡背景与照片墙取的是 project_images.local_path，
   *  正是 E03"卡片背景读远端 URL、每帧重下整图"死锁的根因。每进程仅跑一次，最多 SWEEP_MAX 张。 */
  async sweepArchives() {
    if (this.sweepDone) return;
    this.sweepDone = true;
    const SWEEP_MAX = 40;
    let all;
    try {
      all = projects.imagesMissingLocal();
    } catch (e) {
      log('warn', `图片归档补扫：查询失败（${e.message}）`);
      return;
    }
    if (!all.length) return;
    const pending = all.slice(0, SWEEP_MAX);
    log('info', `图片归档补扫：发现 ${all.length} 张项目图片缺本地备份，本轮补齐 ${pending.length} 张`);
    let ok = 0;
    for (const img of pending) {
      const art = await downloadWithRetry(img.remote_url, 2); // 2 次尝试，避免启动时长阻塞
      if (!art) continue;
      projects.setImageLocal(img.id, art.local_path);
      ok += 1;
    }
    log(
      'info',
      `图片归档补扫完成：补齐 ${ok}/${pending.length} 张` +
        (all.length > pending.length ? `（剩余 ${all.length - pending.length} 张下次启动继续）` : ''),
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 唤醒：清除指定任务的退避标记（手动重试后立即恢复执行资格） */
  kick(taskId) {
    if (taskId) this.retryUntil.delete(Number(taskId));
  }

  /** 退避是否可重试（429 / 网络 / 5xx）；返回 true 表示本轮已处理 */
  backoffOrGiveUp(t, detail) {
    const msg = String(detail).slice(0, 500);
    const prev = this.retryUntil.get(t.id);
    const attempts = (prev?.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.retryUntil.delete(t.id);
      tasks.update(t.id, {
        status: 'failed',
        error_message: `重试 ${MAX_ATTEMPTS} 次仍失败：${msg}`,
        completed_at: Date.now(),
      });
      log('error', `图片任务 #${t.id} 重试耗尽，置为 failed：${msg}`);
      return true;
    }
    this.retryUntil.set(t.id, { until: Date.now() + computeBackoffMs(attempts), attempts });
    // 保留 queued（下一轮 tick 换下一个任务，避免一个退避任务阻塞整队）
    tasks.update(t.id, { status: 'queued', error_message: `第 ${attempts} 次失败，稍后自动重试：${msg}` });
    log(
      'warn',
      `图片任务 #${t.id} 第 ${attempts} 次失败，${Math.round(computeBackoffMs(attempts) / 1000)}s 后重试：${msg}`,
    );
    return true;
  }

  isRetryableError(status, rawErr) {
    // 网络异常（无 status）/ 429 / 5xx 可自动重试
    if (rawErr && !Number.isInteger(rawErr.status)) return true;
    return status === 429 || (status >= 500 && status <= 599);
  }

  async tick() {
    if (this.running) return;
    if (instanceLockHeldByOther()) return; // 单实例工作锁
    this.running = true;
    try {
      const apiKey = settings.get('api_key', '');
      if (!apiKey) return; // 未配置 Key：保留入队状态
      const list = tasks.pendingImages();
      if (!list.length) return;
      // 跳过退避中的任务，取队首执行（串行：上游同步生成 30–180s，逐个执行避免限流）
      const t = list.find((x) => {
        const bo = this.retryUntil.get(x.id);
        return !bo || bo.until <= Date.now();
      });
      if (t) await this.runOne(t, apiKey);
    } finally {
      this.running = false;
    }
  }

  async runOne(t, apiKey) {
    // 置 in_progress 给前端即时反馈（同步上游无进度概念，起步即 10%）
    tasks.update(t.id, { status: 'in_progress', progress: 10 });
    const req = t.request_json || {};
    const count = [1, 2, 3, 4].includes(Number(req.count)) ? Number(req.count) : 1;
    // 还原图片 payload（建任务时已过 buildImagePayload 校验，这里只重组）
    const payload = {
      model: IMAGE_MODEL,
      prompt: t.prompt,
      size: t.size || '1K',
      extra_body: { response_format: 'url' },
    };
    if (t.aspect_ratio) payload.ratio = t.aspect_ratio;
    if (Array.isArray(req.image) && req.image.length) payload.extra_body.image = req.image;

    log('info', `图片任务 #${t.id} 开始生成（${count} 张 · ${t.size}${t.aspect_ratio ? ' · ' + t.aspect_ratio : ''}）`);
    const settled = await Promise.allSettled(
      Array.from({ length: count }, () =>
        agnes.generateImage({ apiKey, baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url), payload }),
      ),
    );
    // 可重试错误判定：全部请求都因限流/网络/5xx 失败时才退避；只要有一张成功（或有不可恢复错误）就落定
    const anyFulfilled = settled.some((s) => s.status === 'fulfilled');
    if (!anyFulfilled) {
      const rejected = settled.find((s) => s.status === 'rejected')?.reason;
      if (this.isRetryableError(null, rejected)) return this.backoffOrGiveUp(t, rejected?.message || '网络异常');
    }
    const remoteUrls = [];
    let unretryableErr = null;
    for (const s of settled) {
      if (s.status !== 'fulfilled' || !s.value.ok) {
        if (s.status === 'rejected') {
          if (!unretryableErr && !this.isRetryableError(null, s.reason)) unretryableErr = s.reason?.message;
          continue;
        }
        if (!unretryableErr && !this.isRetryableError(s.value.status, null)) {
          unretryableErr = s.value.data?.error?.message || `上游返回 HTTP ${s.value.status}`;
        }
        continue;
      }
      const u = safeUrl(s.value.data?.data?.[0]?.url);
      if (u) remoteUrls.push(u);
    }
    if (!remoteUrls.length) {
      const detail =
        unretryableErr ||
        settled.find((s) => s.status === 'rejected')?.reason?.message ||
        (settled[0].status === 'fulfilled'
          ? settled[0].value.data?.error?.message || `上游返回 HTTP ${settled[0].value.status}`
          : '未知错误');
      // 全部失败且含可重试错误 → 退避；否则直接 failed
      const hasRetryable =
        !anyFulfilled ||
        settled.some(
          (s) =>
            (s.status === 'rejected' && this.isRetryableError(null, s.reason)) ||
            (s.status === 'fulfilled' && !s.value.ok && this.isRetryableError(s.value.status, null)),
        );
      if (hasRetryable) return this.backoffOrGiveUp(t, detail);
      this.retryUntil.delete(t.id);
      tasks.update(t.id, {
        status: 'failed',
        error_message: `图片生成失败：${String(detail).slice(0, 500)}`,
        completed_at: Date.now(),
      });
      log('error', `图片任务 #${t.id} 失败：${detail}`);
      return;
    }

    // 成功路径：逐张归档；挂项目时落 project_images 并首张自动定稿（对齐同步接口行为）
    try {
      const imageKind = ['character', 'scene'].includes(req.image_kind) ? req.image_kind : 'character';
      const images = [];
      for (let i = 0; i < remoteUrls.length; i++) {
        const remoteUrl = remoteUrls[i];
        const backup = await downloadWithRetry(remoteUrl);
        let imageId = null;
        if (t.project_id) {
          imageId = projects.addImage({
            project_id: t.project_id,
            kind: imageKind,
            prompt: t.prompt,
            remote_url: remoteUrl,
            local_path: backup?.local_path || null,
            size: t.size || '1K',
            ratio: t.aspect_ratio || '1:1',
            model: IMAGE_MODEL,
          });
          if (i === 0) {
            // v2.5 多角色：仅在"尚无定稿图"时自动定稿首张；后续角色图需手动定稿（否则历史定稿图会在提交时累积注入）
            if (!projects.selectedImage(t.project_id, imageKind)) {
              projects.selectImage(imageId, imageKind, t.project_id);
            }
            if (imageKind === 'character') projects.update(t.project_id, { status: 'character_done' });
          }
        }
        images.push({
          remote_url: remoteUrl,
          local_path: backup?.local_path || null,
          local_url: backup?.local_url || null,
          image_id: imageId,
        });
      }
      this.retryUntil.delete(t.id);
      tasks.update(t.id, {
        status: 'completed',
        progress: 100,
        completed_at: Date.now(),
        images,
        metadata_url: images[0].remote_url,
        video_local_path: images[0].local_path, // 复用本地归档列：下载/展示优先本地（远端 URL 会过期）
        image_id: images[0].image_id || null, // v2.1 溯源首张产物（任务中心来源徽章：角色图/场景图）
        error_message: null,
      });
      const failed = count - images.length;
      log(
        'info',
        `图片任务 #${t.id} 完成：${images.length}/${count} 张${t.project_id ? `（项目 #${t.project_id}）` : ''}${failed ? `，失败 ${failed} 张` : ''}`,
      );
    } catch (e) {
      // 归档/落库阶段异常（磁盘满等）：置 failed，产物 URL 保留在 error 上下文里
      tasks.update(t.id, {
        status: 'failed',
        error_message: `产物处理失败：${String(e.message).slice(0, 400)}`,
        completed_at: Date.now(),
      });
      log('error', `图片任务 #${t.id} 产物处理失败：${e.message}`);
    }
  }
}

module.exports = new ImageWorker();
