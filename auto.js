'use strict';
/**
 * auto.js —— 全自动成片编排器（P3）
 * 把「创意 → 文案 → 分镜 → L1 自审 → 角色图 → 逐镜视频 → 逐镜 TTS → 渲染」串成一条
 * 后台流水线：小白只需一个创意点「全自动」，其余步骤自动推进、失败自动重试、
 * 卡住时停在人工介入点。状态机持久化在 projects.auto_state（JSON），前端可随时
 * 拉取渲染进度时间线。
 *
 * 阶段：script → storyboard → review → character → videos → wait_videos
 *       → tts → render → wait_render → done（失败/停止 → error / stopped）
 * 每阶段最多重试 2 次；L1 审查失败不阻塞（记录 warning 后继续）；
 * TTS 未配置 Fish Key 时跳过（无配音渲染）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { settings, DEFAULT_SETTINGS, projects, tasks, renders, instanceLockHeldByOther } = require('./db');
const agnes = require('./agnes');
const fishTts = require('./fish-tts');
const { log } = require('./logger');
const { ARTIFACTS_DIR } = require('./artifacts');
const { probeDuration } = require('./config');
const { LLM_MODEL, IMAGE_MODEL, SCRIPT_KINDS, SECONDS_OK } = require('./constants');
const { ApiError } = require('./errors');
const {
  SCRIPT_SYSTEM_PROMPT,
  STORYBOARD_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  parseLLMJson,
  normalizeStoryboardShots,
  normalizeReviewResult,
} = require('./services/prompts');
const { buildPayload, submitTask } = require('./services/payloads');
const { createPipelineService } = require('./pipeline');

const TICK_MS = 3000;
const MAX_STAGE_ATTEMPTS = 2; // 每阶段自动重试上限（含首次共 3 次机会）

const pipeline = createPipelineService({ projects, buildPayload, submitTask, ApiError, log });

/** 阶段元数据（前端时间线展示用；与 auto_state.stage 取值一一对应） */
const STAGE_META = {
  script: { label: '生成文案', step: 1 },
  storyboard: { label: '拆分分镜', step: 2 },
  review: { label: 'AI 自审分镜', step: 3 },
  character: { label: '生成角色图', step: 4 },
  videos: { label: '逐镜生成视频', step: 5 },
  wait_videos: { label: '等待视频完成', step: 5 },
  tts: { label: '逐镜配音', step: 6 },
  render: { label: '渲染成片', step: 7 },
  wait_render: { label: '等待渲染完成', step: 7 },
  done: { label: '完成', step: 8 },
  error: { label: '人工介入', step: 8 },
  stopped: { label: '已停止', step: 8 },
};

class AutoPipeline {
  constructor() {
    this.timer = null;
    this.busyProjects = new Set(); // 正在执行阶段动作的项目（防同一项目并发重入）
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) => log('error', `自动成片循环异常: ${e.message}`)), TICK_MS);
    this.timer.unref?.();
    log('info', '自动成片编排器已启动（全自动：文案→分镜→自审→角色图→视频→配音→渲染）');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 启动某项目的全自动成片（幂等：已在运行 → 返回 false） */
  launch(projectId) {
    const p = projects.get(projectId);
    if (!p) return { ok: false, code: 404, message: '项目不存在' };
    const cur = p.auto_state;
    if (cur?.running) return { ok: false, code: 400, message: '该项目全自动成片已在进行中' };
    if (!p.idea) return { ok: false, code: 400, message: '项目缺少创意（idea），无法自动成片' };
    const state = {
      running: true,
      stage: 'script',
      attempts: 0,
      error: null,
      started_at: Date.now(),
      finished_at: null,
      image_task_id: null,
      video_task_ids: [],
      retried_shots: [],
      tts_index: 0,
      render_job_id: null,
      history: [{ stage: 'script', status: 'start', ts: Date.now(), detail: '全自动成片启动' }],
    };
    projects.setAutoState(projectId, state);
    log('info', `项目 #${projectId} 全自动成片启动（创意→成片全自动推进，失败自动重试）`);
    this.tick().catch(() => {}); // 立即推进一次
    return { ok: true, state };
  }

  /** 停止（保留已产出内容；可再次 launch 从头跑） */
  stopProject(projectId) {
    const p = projects.get(projectId);
    if (!p?.auto_state?.running) return { ok: false, code: 400, message: '该项目没有进行中的自动成片' };
    const st = p.auto_state;
    st.running = false;
    st.stage = 'stopped';
    st.history.push({ stage: 'stopped', status: 'stop', ts: Date.now(), detail: '用户手动停止' });
    projects.setAutoState(projectId, st);
    log('info', `项目 #${projectId} 全自动成片已停止（阶段 ${st.history.at(-2)?.stage || '-'}）`);
    return { ok: true, state: st };
  }

  async tick() {
    if (instanceLockHeldByOther()) return; // 单实例工作锁
    // 扫描所有 running 的项目，推进未在执行中的（每 tick 至多启动一个，避免并发雪崩）
    for (const p of projects.list()) {
      if (!p.auto_state?.running) continue;
      if (this.busyProjects.has(p.id)) continue;
      this.busyProjects.add(p.id);
      this.runStage(p.id)
        .catch((e) => {
          // 阶段执行异常 → 计入重试 / 终态 error
          this.stageFail(p.id, String(e.message || e).slice(0, 300));
        })
        .finally(() => this.busyProjects.delete(p.id));
      break; // 本 tick 只启动一个（阶段多为长耗时异步任务）
    }
  }

  /* ---------------- 状态写工具 ---------------- */
  readState(projectId) {
    return projects.get(projectId)?.auto_state || null;
  }
  saveState(projectId, st) {
    projects.setAutoState(projectId, st);
  }
  /** 阶段成功推进 */
  advance(projectId, nextStage, detail) {
    const st = this.readState(projectId);
    if (!st?.running) return;
    st.stage = nextStage;
    st.attempts = 0;
    st.history.push({ stage: nextStage, status: 'ok', ts: Date.now(), detail: String(detail || '').slice(0, 200) });
    this.saveState(projectId, st);
    log('info', `项目 #${projectId} 自动成片：${nextStage}（${String(detail || '').slice(0, 120)}）`);
  }
  /** 阶段失败：未超限 → 重试本阶段；超限 → error（人工介入） */
  stageFail(projectId, message) {
    const st = this.readState(projectId);
    if (!st?.running) return;
    st.attempts = (st.attempts || 0) + 1;
    if (st.attempts > MAX_STAGE_ATTEMPTS) {
      st.running = false;
      st.stage = 'error';
      st.error = String(message).slice(0, 400);
      st.finished_at = Date.now();
      st.history.push({ stage: 'error', status: 'error', ts: Date.now(), detail: st.error });
      this.saveState(projectId, st);
      log('error', `项目 #${projectId} 自动成片中断（${st.stage} 重试耗尽）：${message}`);
    } else {
      st.error = String(message).slice(0, 400);
      st.history.push({
        stage: st.stage,
        status: 'retry',
        ts: Date.now(),
        detail: `第 ${st.attempts} 次失败，重试中：${String(message).slice(0, 150)}`,
      });
      this.saveState(projectId, st);
      log('warn', `项目 #${projectId} 自动成片阶段 ${st.stage} 失败（第 ${st.attempts} 次）：${message}`);
    }
  }
  finish(projectId) {
    const st = this.readState(projectId);
    if (!st?.running) return;
    st.running = false;
    st.stage = 'done';
    st.finished_at = Date.now();
    st.history.push({ stage: 'done', status: 'ok', ts: Date.now(), detail: '成片完成 🎉' });
    this.saveState(projectId, st);
    log('info', `项目 #${projectId} 全自动成片完成 🎉`);
  }

  /* ---------------- 通用 LLM 调用 ---------------- */
  async chat(system, user, { temperature = 0.8, max_tokens = 4000 } = {}) {
    const apiKey = settings.get('api_key', '');
    if (!apiKey) throw new Error('尚未配置 API Key，请先在设置中填写');
    const r = await agnes.chatComplete({
      apiKey,
      baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens,
    });
    if (!r.ok) {
      const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
      throw new Error(`LLM 调用失败（${r.status}）：${String(detail).slice(0, 300)}`);
    }
    return r.data?.choices?.[0]?.message?.content || '';
  }

  /* ---------------- 阶段执行 ---------------- */
  async runStage(projectId) {
    const st = this.readState(projectId);
    if (!st?.running) return;
    const p = projects.get(projectId);
    if (!p) return;
    switch (st.stage) {
      case 'script':
        return this.doScript(projectId, p, st);
      case 'storyboard':
        return this.doStoryboard(projectId, p, st);
      case 'review':
        return this.doReview(projectId, p, st);
      case 'character':
        return this.doCharacter(projectId, p, st);
      case 'videos':
        return this.doVideos(projectId, p, st);
      case 'wait_videos':
        return this.doWaitVideos(projectId, p, st);
      case 'tts':
        return this.doTts(projectId, p, st);
      case 'render':
        return this.doRender(projectId, p, st);
      case 'wait_render':
        return this.doWaitRender(projectId, p, st);
      default:
        return; // done/error/stopped：无需动作
    }
  }

  /** ① 文案：复刻 /api/llm/script 核心逻辑（结构化四件套落库 + 自动选用） */
  async doScript(projectId, p) {
    const userMessage = `一句话创意：${p.idea}\n风格偏好：${p.style || '不限制'}\n画幅：${p.aspect_ratio || '16:9'}\n目标时长：${p.seconds || '5'} 秒`;
    const raw = await this.chat(SCRIPT_SYSTEM_PROMPT, userMessage, { max_tokens: 2000 });
    const parsed = parseLLMJson(raw);
    if (!parsed) throw new Error('文案模型未按结构化 JSON 输出');
    const result = {};
    for (const kind of SCRIPT_KINDS) result[kind] = String(parsed[kind] || '').trim();
    if (!result.video_prompt) throw new Error('文案缺少 video_prompt 字段');
    for (const kind of SCRIPT_KINDS) {
      if (!result[kind]) continue;
      const tid = projects.addText({ project_id: projectId, kind, content: result[kind], model: LLM_MODEL });
      projects.selectText(tid, kind, projectId);
    }
    projects.update(projectId, { status: 'copy_done' });
    this.advance(projectId, 'storyboard', '文案四件套已生成并选用');
  }

  /** ② 分镜：复刻 /api/llm/storyboard 核心逻辑（整版落库 + 重建 shots） */
  async doStoryboard(projectId, p) {
    const userMessage = `一句话创意：${p.idea}\n风格偏好：${p.style || '不限制'}\n画幅：${p.aspect_ratio || '16:9'}\n单镜头目标时长：${p.seconds || '5'} 秒\n镜头数量：未指定（按叙事需要 3~8 个）`;
    const raw = await this.chat(STORYBOARD_SYSTEM_PROMPT, userMessage);
    const parsed = parseLLMJson(raw);
    const rawShots = parsed && Array.isArray(parsed.shots) ? parsed.shots : null;
    if (!rawShots) throw new Error('分镜模型未按结构化 JSON 输出');
    const normalized = normalizeStoryboardShots(rawShots, SECONDS_OK.includes(String(p.seconds)) ? p.seconds : '5');
    if (!normalized.length) throw new Error('分镜规范化后为空（所有镜头提示词缺失）');
    const tid = projects.addText({
      project_id: projectId,
      kind: 'storyboard',
      content: JSON.stringify({ shots: normalized }),
      model: LLM_MODEL,
    });
    projects.selectText(tid, 'storyboard', projectId);
    projects.replaceShots(projectId, normalized);
    this.advance(projectId, 'review', `分镜已生成（${normalized.length} 镜）`);
  }

  /** ③ L1 自审：审查分镜，中低severity 自动采纳修订，高 severity 记录后继续（不阻塞流水线） */
  async doReview(projectId, p) {
    const shots = projects.shots(projectId);
    const script = projects.selectedText(projectId, 'script')?.content || '';
    const charDesc = projects.selectedText(projectId, 'character_desc')?.content || '';
    const storyText = projects
      .texts(projectId)
      .filter((t) => t.kind === 'storyboard' && t.selected)
      .map((t) => t.content)
      .join('\n');
    const userMessage = `【故事梗概】\n${script || p.idea}\n\n【角色描述】\n${charDesc || '（未提供）'}\n\n【分镜脚本（JSON）】\n${storyText || JSON.stringify(shots)}`;
    let reviewed;
    try {
      const raw = await this.chat(REVIEW_SYSTEM_PROMPT, userMessage, { temperature: 0.3, max_tokens: 3000 });
      reviewed = normalizeReviewResult(parseLLMJson(raw));
    } catch (e) {
      // 审查失败不阻塞：记录 warning 继续角色图
      this.advance(projectId, 'character', `分镜自审不可用（${String(e.message).slice(0, 80)}），已跳过`);
      return;
    }
    if (!reviewed || !reviewed.issues.length) {
      this.advance(projectId, 'character', `分镜自审通过：${reviewed?.overall || '无问题'}`);
      return;
    }
    const shotById = new Map(shots.map((s) => [s.seq, s]));
    let applied = 0;
    let pending = [];
    for (const it of reviewed.issues) {
      const shot = shotById.get(it.shot_seq);
      if (!shot) continue;
      if (it.severity === 'high') {
        pending.push(`镜头${it.shot_seq} ${it.issue}`);
        continue; // 高严重度留给人工（不盲改），流水线继续
      }
      const patch = {};
      patch[it.field] = it.revised;
      projects.updateShot(shot.id, patch);
      applied += 1;
    }
    const detail = `自审发现 ${reviewed.issues.length} 项：自动修订 ${applied} 项${pending.length ? `；${pending.length} 项高优先级建议人工确认（${pending[0]}…）` : ''}`;
    this.advance(projectId, 'character', detail);
  }

  /** ④ 角色图：入队异步图片任务（image-worker 接管），随后轮询其完成 */
  async doCharacter(projectId, p, st) {
    // 有在途图片任务 → 先查状态（v2.0.3：此分支须在「已定稿」之前——
    // 工作器完成时会自动定稿，若先查定稿会把「本流水线生成的图」误报为「跳过生成」）
    if (st.image_task_id) {
      const t = tasks.get(st.image_task_id);
      if (!t) {
        st.image_task_id = null;
        this.saveState(projectId, st);
        return;
      }
      if (t.status === 'completed') {
        st.image_task_id = null;
        this.saveState(projectId, st);
        if (projects.selectedImage(projectId, 'character')) {
          this.advance(projectId, 'videos', '角色图已生成并自动定稿');
        } else {
          this.advance(projectId, 'videos', '角色图完成（未自动定稿，视频将按镜头引用开关处理）');
        }
        return;
      }
      if (t.status === 'failed' || t.status === 'submit_error') {
        st.image_task_id = null;
        this.saveState(projectId, st);
        throw new Error(`角色图任务失败：${String(t.error_message || '').slice(0, 200)}`);
      }
      return; // queued / in_progress：下轮 tick 再查
    }
    // 无在途任务但已有定稿角色图（如全自动前手动定稿过）→ 直接下一步
    if (projects.selectedImage(projectId, 'character')) {
      this.advance(projectId, 'videos', '已有定稿角色图，跳过生成');
      return;
    }
    // 无在途任务 → 入队（角色描述优先用文案中的 character_desc）
    const charDesc = projects.selectedText(projectId, 'character_desc')?.content || p.idea;
    const apiKey = settings.get('api_key', '');
    if (!apiKey) throw new Error('尚未配置 API Key');
    const prompt = `角色立绘：${charDesc}。全身或半身构图，干净背景，正面站立，电影级写实，高细节`;
    const taskId = tasks.insert({
      kind: 'image',
      status: 'queued',
      mode: 'text',
      model: IMAGE_MODEL,
      prompt,
      size: '1K',
      aspect_ratio: '1:1',
      request_json: {
        model: IMAGE_MODEL,
        prompt,
        size: '1K',
        extra_body: { response_format: 'url' },
        count: 1,
        image_kind: 'character',
      },
      project_id: projectId,
    });
    st.image_task_id = taskId;
    this.saveState(projectId, st);
    log('info', `项目 #${projectId} 自动成片：角色图任务 #${taskId} 已入队`);
  }

  /** ⑤ 提交全部镜头视频（逐镜入队；节流由 submitter 全局队列负责） */
  async doVideos(projectId, _p, st) {
    const shots = projects.shots(projectId);
    if (!shots.length) throw new Error('无镜头可提交');
    const ids = [];
    for (const s of shots) {
      const task = await pipeline.submitVideoTask({
        projectId,
        shot: s,
        prompt: s.video_prompt,
        seconds: s.seconds,
        aspectRatio: projects.get(projectId).aspect_ratio,
        shotId: s.id,
      });
      ids.push(task.id);
    }
    st.video_task_ids = ids;
    this.saveState(projectId, st);
    this.advance(projectId, 'wait_videos', `已入队 ${ids.length} 个镜头视频任务`);
  }

  /** ⑤.5 等待视频：全部完成 → TTS；失败镜头自动重拍一次；重拍仍失败 → error */
  async doWaitVideos(projectId, _p, st) {
    const shots = projects.shots(projectId);
    const allTasks = projects.tasks(projectId);
    let failed = [];
    let pending = 0;
    for (const s of shots) {
      // 镜头定稿 take 优先（与渲染取素材逻辑一致），否则最新任务
      const mine = allTasks.filter((t) => t.shot_id === s.id).sort((a, b) => b.id - a.id);
      const done = mine.find((t) => t.status === 'completed');
      if (done) continue;
      const latest = mine[0];
      if (!latest) {
        // 该镜头没任务（可能中途被删）→ 直接重提
        failed.push(s);
        continue;
      }
      if (latest.status === 'failed' || latest.status === 'submit_error') {
        if (!(st.retried_shots || []).includes(s.id)) failed.push(s);
        else {
          throw new Error(`镜头 ${s.seq} 重拍后仍失败：${String(latest.error_message || '').slice(0, 150)}`);
        }
        continue;
      }
      pending += 1; // queued / in_progress
    }
    if (pending > 0) return; // 等下一轮
    if (failed.length) {
      // 自动重拍失败镜头（每镜头一次）
      for (const s of failed) {
        await pipeline.submitVideoTask({
          projectId,
          shot: s,
          prompt: s.video_prompt,
          seconds: s.seconds,
          aspectRatio: projects.get(projectId).aspect_ratio,
          shotId: s.id,
        });
        st.retried_shots = [...(st.retried_shots || []), s.id];
      }
      this.saveState(projectId, st);
      log('info', `项目 #${projectId} 自动成片：${failed.length} 个失败镜头已自动重拍`);
      return;
    }
    this.advance(projectId, 'tts', '全部镜头视频完成');
  }

  /** ⑥ 逐镜 TTS：每次 tick 合成一条（绑定镜头）；未配置 Fish Key 或合成失败 → 跳过（配音是可选环节，不阻塞成片） */
  async doTts(projectId, _p, st) {
    const apiKey = settings.get('fish_api_key', '');
    if (!apiKey) {
      this.advance(projectId, 'render', '未配置 Fish Audio Key，跳过配音');
      return;
    }
    const shots = projects.shots(projectId);
    const targets = shots.filter((s) => (s.narration || '').trim());
    const idx = st.tts_index || 0;
    if (idx >= targets.length) {
      this.advance(projectId, 'render', `配音处理完成（${targets.length} 镜旁白）`);
      return;
    }
    const s = targets[idx];
    const voice = settings.get('fish_voice', 'default');
    const speed = Number(settings.get('fish_speed', '1')) || 1;
    const r = await fishTts.synthesize({
      apiKey,
      text: s.narration,
      referenceId: voice === 'default' ? null : voice,
      speed,
      format: 'mp3',
    });
    if (!r.ok) {
      // 配音失败降级为跳过：成片可以无旁白渲染，不让 TTS 问题挡住整条流水线
      st.tts_index = idx + 1;
      st.history.push({
        stage: 'tts',
        status: 'skip',
        ts: Date.now(),
        detail: `镜头 ${s.seq} 配音失败已跳过：${String(r.raw || r.status).slice(0, 120)}`,
      });
      this.saveState(projectId, st);
      log('warn', `项目 #${projectId} 自动成片：镜头 ${s.seq} 配音失败已跳过（不阻塞成片）`);
      return;
    }
    // 落盘 + 落库 + 绑定镜头（复刻 /api/tts/generate 核心逻辑）
    let localPath;
    try {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      const name = `tts${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`;
      localPath = path.join(ARTIFACTS_DIR, name);
      fs.writeFileSync(localPath, r.buf);
    } catch {
      localPath = null;
    }
    const duration = localPath ? probeDuration(localPath) : null;
    const tid = projects.addTts({
      project_id: projectId,
      kind: 'shot',
      shot_id: s.id,
      text: s.narration,
      model: 's2.1-pro-free',
      reference_id: voice === 'default' ? null : voice,
      voice_title: voice === 'default' ? '平台默认音色' : voice,
      format: 'mp3',
      local_path: localPath,
      duration,
      size: r.buf?.length || null,
    });
    projects.selectTts(tid, projectId);
    st.tts_index = idx + 1;
    this.saveState(projectId, st);
    log(
      'info',
      `项目 #${projectId} 自动成片：镜头 ${s.seq} 配音完成（${duration || '?'}s，${idx + 1}/${targets.length}）`,
    );
  }

  /** ⑦ 渲染：发起（默认参数）；随后轮询 */
  async doRender(projectId, _p, st) {
    const jobId = renders.insert({ project_id: projectId, params: {} });
    st.render_job_id = jobId;
    this.saveState(projectId, st);
    this.advance(projectId, 'wait_render', `渲染任务 #${jobId} 已创建`);
  }

  /** ⑦.5 等待渲染完成 */
  async doWaitRender(projectId, _p, st) {
    const job = st.render_job_id ? renders.get(st.render_job_id) : null;
    if (!job) throw new Error('渲染任务记录丢失');
    if (job.status === 'completed') {
      this.finish(projectId);
      return;
    }
    if (job.status === 'failed') {
      throw new Error(`渲染失败：${String(job.error_message || '').slice(0, 200)}`);
    }
    // queued / rendering：等下一轮
  }
}

module.exports = new AutoPipeline();
module.exports.STAGE_META = STAGE_META;
