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
  'agnes-video-v2.0': 'V2.0',
};
const modelInfo = (id) => META?.models.find((m) => m.id === id) || null;
const modelShort = (id) => modelInfo(id)?.short || MODEL_NAME_FALLBACK[id] || String(id).replace('agnes-video-', '');
const selectableModels = () => (META ? META.models.filter((m) => !m.deprecated) : []);
const DEFAULT_MODEL = () =>
  (selectableModels().find((m) => m.free) || selectableModels()[0])?.id || 'agnes-video-2.5-flash';

/** 模型切换联动：更新提示、size 选项与视频参考能力显隐（供新建任务表单绑定） */
function onModelChange() {
  const info = modelInfo($('#fModel').value);
  $('#modelHint').textContent = info ? `（${info.hint}）` : '';
  $('#fSize').innerHTML = (info?.sizes?.length ? info.sizes : ['720P'])
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');
  const grpVideos = $('#grpVideos');
  if (grpVideos) grpVideos.classList.toggle('hidden', info ? !info.video_ref : false);
}

/** 拉取 /api/meta 并填充两处模型/规格下拉（新建任务表单 + 设置弹窗默认模型） */
async function loadMeta() {
  META = await api('/api/meta');
  // 新建任务表单下拉（视频）
  $('#fModel').innerHTML = selectableModels()
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
    .join('');
  $('#fSeconds').innerHTML = META.seconds
    .map((s) => `<option value="${esc(s)}" ${s === '5' ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  $('#fAspect').innerHTML = META.aspect_ratios
    .map((a) => `<option value="${esc(a)}" ${a === '16:9' ? 'selected' : ''}>${esc(a)}</option>`)
    .join('');
  // P1：新建任务表单下拉（图片）
  const img = META.image || {};
  $('#fiSize').innerHTML = (img.sizes?.length ? img.sizes : ['1K'])
    .map((s) => `<option value="${esc(s)}" ${s === '1K' ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  $('#fiRatio').innerHTML = (img.ratios?.length ? img.ratios : ['1:1'])
    .map((r) => `<option value="${esc(r)}" ${r === '1:1' ? 'selected' : ''}>${esc(r)}</option>`)
    .join('');
  // 设置弹窗默认模型下拉（同样只列未下架模型）
  $('#setModel').innerHTML = selectableModels()
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`)
    .join('');
}

export { modelInfo, modelShort, selectableModels, DEFAULT_MODEL, onModelChange, loadMeta };
