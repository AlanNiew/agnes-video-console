/* task-meta.js —— 模型/画幅/时长元数据（M4-B2：自 app.js 拆出的视图无关数据模块）
 * GET /api/meta 单一事实来源：模块级 META + 查询函数 + 新建任务/设置弹窗下拉填充。
 * 依赖：common.js（$、esc）。被 new-task / settings-panel / task-center 显式 import。
 */
import { $, esc, toast, api } from './common.js';

/* ---------------- 模型元数据（GET /api/meta，单一事实来源；加载完成前的静态兜底） ---------------- */
let META = null;
const MODEL_NAME_FALLBACK = {
  'agnes-video-2.5-flash': 'Flash',
  'agnes-video-2.5': '2.5',
  'agnes-video-v2.0': 'V2.0',
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
const dreaminaVideoInfo = (id) => (dreaminaMeta()?.video || []).find((m) => m.id === id) || null;
const dreaminaImageInfo = (id) => (dreaminaMeta()?.image || []).find((m) => m.id === id) || null;
const dreaminaAvailable = () => Boolean(dreaminaMeta()?.installed);

/** 生成 [min, max] 的整数秒选项（即梦时长范围与 Agnes 不同，需按模型动态生成） */
function durationOptions(min, max) {
  const lo = Math.max(Number(min) || 4, 1);
  const hi = Math.min(Number(max) || 15, 120);
  const out = [];
  for (let s = lo; s <= hi; s++) out.push(`<option value="${s}" ${s === lo ? 'selected' : ''}>${s}</option>`);
  return out.join('');
}

/** 视频模型下拉（Agnes 分组 + 即梦分组） */
function videoModelOptions() {
  const agnes = selectableModels()
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
    .join('');
  const groups = [`<optgroup label="Agnes（免费 / 自有配额）">${agnes}</optgroup>`];
  if (dreaminaAvailable()) {
    const items = (dreaminaMeta().video || [])
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
      .join('');
    groups.push(`<optgroup label="即梦（收费 · 会员积分）">${items}</optgroup>`);
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

/** 模型切换联动：更新提示、size 选项与视频参考能力显隐（供新建任务表单绑定） */
function onModelChange() {
  const id = $('#fModel').value;
  const dm = dreaminaVideoInfo(id);
  if (dm) {
    // 即梦分支：规格取自模型自身（与 Agnes 的 720P/960P/2K 体系不同）
    $('#modelHint').textContent =
      `（即梦 · 会员积分计费 · ${dm.resolutions.join('/')} · ${dm.min_duration}-${dm.max_duration}s` +
      `${dm.vip_only ? ' · VIP' : ''}）`;
    $('#fSize').innerHTML = dm.resolutions.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    $('#fSeconds').innerHTML = durationOptions(dm.min_duration, dm.max_duration);
    // 即梦当前仅支持文生视频：隐藏模式切换与素材区作为视觉提示，
    // collectBody 提交时亦会强制 mode=text 兜底（防止残留在 reference 状态）
    $('#modeTabs')?.classList.add('hidden');
    $('#grpKeyframe')?.classList.add('hidden');
    $('#grpReference')?.classList.add('hidden');
    $('#grpVideos')?.classList.add('hidden');
    return;
  }
  // —— Agnes 分支 ——
  const info = modelInfo(id);
  $('#modelHint').textContent = info ? `（${info.hint}）` : '';
  $('#fSize').innerHTML = (info?.sizes?.length ? info.sizes : ['720P'])
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');
  $('#modeTabs')?.classList.remove('hidden');
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
    }
    const g = await api('/api/dreamina/cost?' + q.toString());
    if (!g?.ok) return true;
    if (g.level === 'block') {
      toast(
        `积分可能不足：本次约需 ${g.points}${g.remaining != null ? `，剩余 ${g.remaining}` : ''}。` +
          '请改用 Agnes 模型或先充值',
        'err',
      );
      return false;
    }
    if (g.level === 'confirm') {
      const conf =
        '即梦生成确认\n\n' +
        `预估消耗：${g.points} 积分` +
        `${g.confidence === 'estimated' ? '（推断值，实际以扣费为准）' : '（实测标定）'}\n` +
        `明细：${g.breakdown}\n` +
        (g.remaining != null ? `当前剩余：${g.remaining} 积分\n` : '') +
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
