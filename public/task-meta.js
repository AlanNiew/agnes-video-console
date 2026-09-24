/* task-meta.js —— 模型/画幅/时长元数据（M4-B2：自 app.js 拆出的视图无关数据模块）
 * GET /api/meta 单一事实来源：模块级 META + 查询函数 + 新建任务/设置弹窗下拉填充。
 * 依赖：common.js（$、esc）。被 new-task / settings-panel / task-center 显式 import。
 */
import { $, esc, api } from './common.js';

/* ---------------- 模型元数据（GET /api/meta，单一事实来源；加载完成前的静态兜底） ---------------- */
let META = null;
const MODEL_NAME_FALLBACK = {
  'agnes-video-2.5-flash': 'Flash',
  'agnes-video-2.5': '2.5',
  'agnes-video-v2.0': 'V2.0', // 模型已于 2026-09-25 下线；保留仅为历史任务的展示映射
};
const modelInfo = (id) => META?.models.find((m) => m.id === id) || null;
const modelShort = (id) => modelInfo(id)?.short || MODEL_NAME_FALLBACK[id] || String(id).replace('agnes-video-', '');
const selectableModels = () => (META ? META.models.filter((m) => !m.deprecated) : []);
const DEFAULT_MODEL = () =>
  (selectableModels().find((m) => m.free) || selectableModels()[0])?.id || 'agnes-video-2.5-flash';

/* ---------------- 即梦（可选上游）元数据与分组渲染 ----------------
 * 即梦模型由 /api/meta 的 dreamina 字段单独下发（**不在 models 里**，避免污染 Agnes 下拉契约）。
 * 未安装 CLI 时不下拉展示即梦分组——否则用户选中后必然提交失败。 */

const dreaminaMeta = () => META?.dreamina || null;
const dreaminaImageInfo = (id) => (dreaminaMeta()?.image || []).find((m) => m.id === id) || null;
const dreaminaAvailable = () => Boolean(dreaminaMeta()?.installed);

/**
 * 查询即梦视频模型在指定模式下是否可用；可用时返回带 `spec`（该子命令的规格）与 `command` 的对象。
 * mode 映射：'text' → text2video；'keyframe' → image2video（本系统只支持单首帧）；
 * 'reference' → multimodal2video（**v2.6.8 起已接入**，即梦「全能参考」）。
 * 之所以要按模式判断：官方各子命令的支持集不同（1.0fast/1.5pro 仅支持图生视频）。
 */
function dreaminaVideoInfo(id, mode = 'text') {
  const m = (dreaminaMeta()?.video || []).find((x) => x.id === id);
  if (!m) return null;
  const command = mode === 'reference' ? 'multimodal2video' : mode === 'keyframe' ? 'image2video' : 'text2video';
  const spec = m.specs?.[command];
  return spec ? { ...m, spec, command } : null;
}

/** 生成 [min, max] 的整数秒选项（即梦时长范围与 Agnes 不同，需按模型动态生成） */
function durationOptions(min, max) {
  const lo = Math.max(Number(min) || 4, 1);
  const hi = Math.min(Number(max) || 15, 120);
  const out = [];
  for (let s = lo; s <= hi; s++) out.push(`<option value="${s}" ${s === lo ? 'selected' : ''}>${s}</option>`);
  return out.join('');
}

/**
 * 视频模型下拉（Agnes 分组 + 即梦分组）。
 * @param {'text'|'keyframe'|'reference'} mode 按当前模式过滤即梦模型——
 *   仅列支持对应子命令的模型（如 keyframe 时隐藏只支持文生视频的老代际差异）
 */
function videoModelOptions(mode = 'text') {
  const agnes = selectableModels()
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
    .join('');
  const groups = [`<optgroup label="Agnes（免费 / 自有配额）">${agnes}</optgroup>`];
  if (dreaminaAvailable() && mode !== 'reference') {
    const command = mode === 'keyframe' ? 'image2video' : 'text2video';
    const items = (dreaminaMeta().video || [])
      .filter((m) => m.specs?.[command])
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
      .join('');
    if (items) groups.push(`<optgroup label="即梦（收费 · 会员积分）">${items}</optgroup>`);
  }
  return groups.join('');
}

/** 图片模型下拉（默认即梦——「图走即梦」是既定策略；未安装 CLI 时回退 Agnes） */
function imageModelOptions() {
  const agnesId = META?.image?.model || 'agnes-image-2.5-flash';
  const dmAvail = dreaminaAvailable();
  const groups = [];
  if (dmAvail) {
    const items = (dreaminaMeta().image || [])
      .map((m, i) => `<option value="${esc(m.id)}" ${i === 0 ? 'selected' : ''}>${esc(m.label)}</option>`)
      .join('');
    groups.push(`<optgroup label="即梦（收费 · 会员积分，1 积分≈4 张）">${items}</optgroup>`);
  }
  groups.push(
    `<optgroup label="Agnes（免费 / 自有配额）">` +
      `<option value="${esc(agnesId)}"${dmAvail ? '' : ' selected'}>Agnes 图片（含免费额度）</option>` +
      `</optgroup>`,
  );
  return groups.join('');
}

/** 模型切换联动：更新提示、size/seconds 选项与素材区显隐（供新建任务表单绑定） */
function onModelChange() {
  const id = $('#fModel').value;
  const mode = $('#modeTabs .tab.active')?.dataset.mode || 'text';
  const isDmModel = (dreaminaMeta()?.video || []).some((m) => m.id === id);

  // 即梦 + 参考模式：v2.6.8 起已接入「全能参考」（multimodal2video），不再拦截；
  // 但实测即梦侧该子命令常失败（generation failed），故在上面的 hint 里给出改用首帧的建议。

  const dm = dreaminaVideoInfo(id, mode);
  if (dm) {
    // 即梦分支：规格取自该**子命令**的 spec（各子命令的时长/分辨率范围不同）
    const s = dm.spec;
    const cmdLabel =
      dm.command === 'image2video' ? '图生视频' : dm.command === 'multimodal2video' ? '全能参考' : '文生视频';
    const refWarn =
      dm.command === 'multimodal2video'
        ? '；⚠ 实测即梦侧常返回 generation failed，建议优先用「首尾帧控制」传首帧图'
        : '';
    $('#modelHint').textContent =
      `（即梦 ${cmdLabel} · 积分计费 · ${s.resolutions.join('/')} · ${s.minDuration ?? s.min_duration}-${s.maxDuration ?? s.max_duration}s` +
      `${(dm.vipOnly ?? dm.vip_only) ? ' · VIP' : ''}${s.omitRatio ? ' · 画幅随首帧' : ''}${refWarn}）`;
    $('#fSize').innerHTML = s.resolutions.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    $('#fSeconds').innerHTML = durationOptions(s.min_duration, s.max_duration);
    // 未接入的素材区隐藏：尾帧属 frames2video、参考文本属 multimodal2video
    $('#grpVideos')?.classList.add('hidden');
    // 2.5 图生视频会拒绝 --ratio（画幅由首帧决定）→ 表单同步禁用，避免误以为设置生效
    const aspect = $('#fAspect');
    if (aspect) aspect.disabled = Boolean(s.omit_ratio);
    return;
  }

  // —— Agnes 分支 ——
  const info = modelInfo(id);
  $('#modelHint').textContent = info ? `（${info.hint}）` : '';
  $('#fSize').innerHTML = (info?.sizes?.length ? info.sizes : ['720P'])
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');
  const aspect = $('#fAspect');
  if (aspect) aspect.disabled = false;
  const grpVideos = $('#grpVideos');
  if (grpVideos) grpVideos.classList.toggle('hidden', info ? !info.video_ref : false);
}

/** 图片模型切换联动：切换 size 白名单（即梦按次计费，禁用候选张数） */
function onImageModelChange() {
  const el = $('#fiModel');
  if (!el) return;
  const dm = dreaminaImageInfo(el.value);
  const img = META?.image || {};
  if (dm) {
    $('#fiModelHint').textContent = '（即梦 · 按次计费，一次请求约返回 4 张候选）';
    $('#fiSize').innerHTML = dm.resolutions.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const fc = $('#fiCount');
    if (fc) fc.disabled = true; // 成本与张数无关，避免误导
    return;
  }
  $('#fiModelHint').textContent = '';
  $('#fiSize').innerHTML = (img.sizes?.length ? img.sizes : ['1K'])
    .map((s) => `<option value="${esc(s)}" ${s === '1K' ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  const fc = $('#fiCount');
  if (fc) fc.disabled = false;
}

/**
 * 失败任务「升级到即梦」的目标模型（阶段 5）。
 * 视频优先取非 VIP 模型（standard 会员可用）；图片取最省的首档（3.1）。
 * 未安装 CLI 时返回 null（调用方据此隐藏入口）。
 */
function dreaminaUpgradeTarget(kind) {
  const dm = dreaminaMeta();
  if (!dm?.installed) return null;
  if (kind === 'image') return dm.image?.[0]?.id || null;
  const v = (dm.video || []).find((m) => !m.vip_only) || (dm.video || [])[0];
  return v?.id || null;
}

/**
 * 工作台角色图（第③步）的模型联动：切换 size 白名单
 * （即梦 1k/2k 与 Agnes 1K–4K 不同），即梦按次计费时禁用候选张数。
 */
function onWorkspaceImgModelChange() {
  const el = $('#wsImgModel');
  if (!el) return;
  const dm = dreaminaImageInfo(el.value);
  const sizes = dm ? dm.resolutions : META?.image?.sizes || ['1K'];
  const sel = $('#wsImgSize');
  if (sel) sel.innerHTML = sizes.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const cnt = $('#wsImgCount');
  if (cnt) cnt.disabled = Boolean(dm);
}

/**
 * 成本护栏（共享：新建任务表单 + 工作台角色图均复用）。
 * 仅对即梦模型生效，Agnes 零打扰。pass 静默 / confirm 弹窗 / block 阻断。
 * 护栏查询本身失败时不阻断主流程（后端仍会做参数与业务校验）。
 * @param {object} body 请求体（含 model，可选 size/seconds）
 * @param {'image'|'video'} kind
 * @returns {Promise<boolean>} 是否继续提交
 */
async function passDreaminaGuard(body, kind) {
  const info = kind === 'image' ? dreaminaImageInfo(body.model) : dreaminaVideoInfo(body.model);
  if (!info) return true; // 非即梦模型
  try {
    const q = new URLSearchParams({ model: body.model });
    if (kind === 'image') {
      if (body.size) q.set('size', body.size);
    } else {
      if (body.seconds) q.set('duration', body.seconds);
      if (body.size) q.set('video_resolution', body.size);
      // 有首帧 → 后端按 image2video 的规格与单价预估（各子命令范围不同）
      if (body.first_frame || body.image) q.set('first_frame', '1');
    }
    const g = await api('/api/dreamina/cost?' + q.toString());
    if (!g?.ok) return true;
    if (g.level === 'block') {
      // v2.6.1：额度不足不再硬拦 —— 服务端会按「回退免费档」规则改用 Agnes 完成本次生成，
      // 这里如实告知并让用户决定是否继续（避免"以为提交了即梦、实际一直排不上"）。
      return window.confirm(
        '即梦积分可能不足\n\n' +
          `本次约需 ${g.points} 积分${g.remaining != null ? `，剩余 ${g.remaining}` : ''}。\n` +
          `继续提交将自动改用免费档（${g.free_model || 'Agnes'}）完成这次生成。\n\n继续？`,
      );
    }
    if (g.level === 'confirm') {
      // 视频排队风险实测提醒：standard 会员并发上限 = 1，一个卡住的任务会占满额度，
      // 导致后续提交报 ExceedConcurrencyLimit（实测 2026-09：排队以「天」计且队列净增长）。
      const risk =
        kind === 'video'
          ? '\n⚠️ 实测提醒：standard 会员的即梦视频排队可达数天（并发上限 1），' +
            '且卡住的任务会占满额度、令后续提交报「并发超限」。\n' +
            '若非必要，建议改用免费的 Agnes 视频（实测 5–9 分钟稳定出片）。\n'
          : '';
      const conf =
        '即梦生成确认\n\n' +
        `预估消耗：${g.points} 积分` +
        `${g.confidence === 'estimated' ? '（推断值，实际以扣费为准）' : '（实测标定）'}\n` +
        `明细：${g.breakdown}\n` +
        (g.remaining != null ? `当前剩余：${g.remaining} 积分\n` : '') +
        risk +
        '\n确认提交？';
      return window.confirm(conf);
    }
    return true; // pass：静默通过（图片等小额场景）
  } catch {
    return true;
  }
}

/** 拉取 /api/meta 并填充两处模型/规格下拉（新建任务表单 + 设置弹窗默认模型） */
async function loadMeta() {
  META = await api('/api/meta');
  // 新建任务表单下拉（视频）：Agnes 与即梦分组渲染
  $('#fModel').innerHTML = videoModelOptions();
  $('#fSeconds').innerHTML = META.seconds
    .map((s) => `<option value="${esc(s)}" ${s === '5' ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  $('#fAspect').innerHTML = META.aspect_ratios
    .map((a) => `<option value="${esc(a)}" ${a === '16:9' ? 'selected' : ''}>${esc(a)}</option>`)
    .join('');
  // P1：新建任务表单下拉（图片）——模型 + 规格
  const fiModel = $('#fiModel');
  if (fiModel) {
    fiModel.innerHTML = imageModelOptions();
    onImageModelChange();
  }
  const img = META.image || {};
  if (fiModel) {
    // onImageModelChange 已按选中的模型填过 size，此处只补 ratio
    $('#fiRatio').innerHTML = (img.ratios?.length ? img.ratios : ['1:1'])
      .map((r) => `<option value="${esc(r)}" ${r === '1:1' ? 'selected' : ''}>${esc(r)}</option>`)
      .join('');
  } else {
    $('#fiSize').innerHTML = (img.sizes?.length ? img.sizes : ['1K'])
      .map((s) => `<option value="${esc(s)}" ${s === '1K' ? 'selected' : ''}>${esc(s)}</option>`)
      .join('');
    $('#fiRatio').innerHTML = (img.ratios?.length ? img.ratios : ['1:1'])
      .map((r) => `<option value="${esc(r)}" ${r === '1:1' ? 'selected' : ''}>${esc(r)}</option>`)
      .join('');
  }
  // 设置弹窗默认模型下拉（只列 Agnes——即梦刻意不设为默认，符合成本均衡）
  $('#setModel').innerHTML = selectableModels()
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
    .join('');
}

export {
  modelInfo,
  modelShort,
  selectableModels,
  DEFAULT_MODEL,
  onModelChange,
  onImageModelChange,
  onWorkspaceImgModelChange,
  videoModelOptions,
  imageModelOptions,
  passDreaminaGuard,
  dreaminaVideoInfo,
  dreaminaImageInfo,
  dreaminaAvailable,
  dreaminaUpgradeTarget,
  loadMeta,
};
