'use strict';
/**
 * pipeline.js —— 创作流水线服务层（M2 / v1.3）
 * 把「角色定稿图 + 视频提示词 → 2.5-flash reference 请求 → 任务入队」的编排
 * 从路由中抽出，供旧版整项目提交与单镜头提交复用。
 * v1.3：镜头级行（shot）传入后尊重 use_character_ref / mode ——
 *       纯空镜镜头（use_character_ref=0 或 mode='text'）走纯文生模式，
 *       不要求角色图、不注入 <Picture 1> 前缀。
 * 依赖由 server.js 注入（避免循环 require）。
 */
const { ensureCharacterRefPrefix, ensureStyleAnchor } = require('./prompts');

function createPipelineService(deps) {
  const { projects, buildPayload, submitTask, ApiError, log } = deps;

  /**
   * 组装并提交一条项目/镜头视频任务（提交队列语义：入队即返回）
   * @param {object} o
   * @param {number} o.projectId   项目 id
   * @param {object|null} [o.shot] 镜头行（单镜头提交时传入，用于引用开关判定）
   * @param {string} o.prompt      视频提示词（允许为空串，由调用方先做回退解析）
   * @param {string} [o.seconds]   覆盖时长（默认继承项目）
   * @param {string} [o.aspectRatio] 覆盖画幅（默认继承项目）
   * @param {number|null} [o.shotId] 镜头溯源（M2）
   * @returns {object} 新建任务行（queued，待提交器提交）
   */
  /** 组装「实际会发给上游」的提示词与参考图（提交与预览共用同一来源，杜绝"库里的值 ≠ 发出的值"） */
  function composeSubmission({ p, shot, prompt }) {
    const text = String(prompt || '').trim();
    if (!text) throw new ApiError(400, '缺少视频提示词（请先生成或手动输入）');
    // v2.5.1：风格锚兜底（纯文生/引用角色 两条分支共用）——手工改过的提示词常丢掉它，
    // 会静默漂移成写实风格（E03 镜8 实测）。与 <Picture N> 前缀同为确定性机械注入。
    const anchored = ensureStyleAnchor(text, p.style);
    // v1.3 引用开关：镜头明确关闭（use_character_ref=0 或 mode=text）→ 纯文生模式
    const useRef = !shot || (shot.use_character_ref !== 0 && shot.mode !== 'text');
    if (!useRef) return { mode: 'text', prompt: anchored, refs: [] };
    // v2.5 多角色引用：项目全部定稿角色图（kind='character' 允许多张）；镜头可用 ref_image_ids 指定本镜出场角色
    const allChars = projects.selectedImages(p.id, 'character');
    let refs = allChars;
    if (shot && Array.isArray(shot.ref_image_ids) && shot.ref_image_ids.length) {
      const idSet = new Set(shot.ref_image_ids.map(Number));
      const picked = allChars.filter((c) => idSet.has(c.id));
      if (picked.length) refs = picked;
    }
    refs = refs.filter((c) => c.remote_url).slice(0, 5); // Flash 上限：images ≤ 5 张
    if (!refs.length) {
      throw new ApiError(400, '请先完成「角色设定」并定稿角色图（纯空镜镜头可在镜头中关闭「引用角色图」）');
    }
    // 提示词中必须引用角色图，显式保持外观一致（前缀注入单一来源见 services/prompts.js）
    return { mode: 'reference', prompt: ensureCharacterRefPrefix(anchored, refs.length), refs };
  }

  async function submitVideoTask({ projectId, shot = null, prompt, seconds, aspectRatio, shotId = null }) {
    const p = projects.get(projectId);
    if (!p) throw new ApiError(404, '项目不存在');
    const secondsFinal = String(seconds || p.seconds || '5');
    const ratioFinal = String(aspectRatio || p.aspect_ratio || '16:9');
    const { mode, prompt: finalPrompt, refs } = composeSubmission({ p, shot, prompt });
    const base = {
      model: 'agnes-video-2.5-flash',
      prompt: finalPrompt,
      mode,
      seconds: secondsFinal,
      size: '720P',
      aspect_ratio: ratioFinal,
    };
    const { payload, meta } = buildPayload(
      mode === 'reference' ? { ...base, images: refs.map((c) => c.remote_url) } : base,
    );
    const task = await submitTask(payload, meta, {
      project_id: p.id,
      shot_id: shotId,
      ...(mode === 'reference' ? { image_id: refs[0].id } : {}), // 溯源主图（首张定稿角色图）
    });
    log(
      'info',
      `项目 #${p.id} 发起视频任务 #${task.id}${shotId ? `（镜头 #${shotId}）` : ''}` +
        (mode === 'reference'
          ? `（引用角色图 ${refs.map((c) => '#' + c.id).join('/')}，共 ${refs.length} 张）`
          : '（纯文生模式，未引用角色图）'),
    );
    return task;
  }

  /** v2.5.1 预览：本镜「实际会发给上游」的提示词（含自动注入的风格锚/角色前缀）
   *  动机：E03 的风格漂移正是"库里的提示词 ≠ 实际发出的提示词"且不可见——此接口让它可见可核对。 */
  function previewVideoPrompt({ projectId, shotId }) {
    const p = projects.get(projectId);
    if (!p) throw new ApiError(404, '项目不存在');
    const shot = projects.shots(p.id).find((s) => s.id === Number(shotId));
    if (!shot) throw new ApiError(404, '镜头不存在（或不属于该项目）');
    const raw = String(shot.video_prompt || '').trim();
    const warnings = [];
    const anchored = ensureStyleAnchor(raw, p.style);
    if (anchored !== raw) warnings.push('已自动补齐项目风格锚（库内提示词未包含）');
    let out;
    try {
      out = composeSubmission({ p, shot, prompt: raw });
    } catch (e) {
      return {
        mode: 'blocked',
        blocked_reason: e.message,
        prompt: anchored,
        prompt_raw: raw,
        style_anchor: p.style || '',
        warnings,
        refs: [],
      };
    }
    if (out.mode === 'reference' && !/<Picture\s*\d/i.test(raw)) {
      warnings.push(`已自动注入角色引用前缀（<Picture 1>…<Picture ${out.refs.length}>）`);
    }
    return {
      mode: out.mode,
      prompt: out.prompt,
      prompt_raw: raw,
      style_anchor: p.style || '',
      warnings,
      refs: out.refs.map((c) => ({ id: c.id, remote_url: c.remote_url })),
    };
  }

  return { submitVideoTask, previewVideoPrompt };
}

module.exports = { createPipelineService };
