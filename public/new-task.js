/* new-task.js —— 新建生成任务弹窗（M4-B2：自 app.js 拆出）
 * 视频/图片任务表单、模式 Tab、参考素材列表、示例模板、AI 优化提示词与提交。
 * 依赖：common.js、state.js（提交后广播 tasks-changed）、compare.js、task-meta.js。
 */
import { $, $$, esc, toast, api } from './common.js';
import { bus } from './state.js';
import { compare } from './compare.js';
import { onModelChange, DEFAULT_MODEL } from './task-meta.js';

const refState = { images: [], audios: [], videos: [] };
let taskType = 'video'; // P1：新建任务类型（video | image）

function openNewTask(initial) {
  // 打开即统一重置：取消关闭后的残留草稿、类型/模式页签、规格都不会带进下次
  resetNewTaskModal();
  if (initial) applyTemplate(initial);
  $('#newTaskModal').hidden = false;
}

/** P1：新建任务类型切换（视频 ⇄ 图片），两套表单互斥 */
function switchTaskType(ptype) {
  taskType = ptype === 'image' ? 'image' : 'video';
  $$('#taskTypeTabs .type-tab').forEach((t) => t.classList.toggle('active', t.dataset.ptype === taskType));
  $('#v25Form').hidden = taskType !== 'video';
  $('#imageForm').hidden = taskType !== 'image';
}

/** P1：图片任务请求体 */
function collectImageBody() {
  return {
    prompt: $('#fiPrompt').value.trim(),
    size: $('#fiSize').value || '1K',
    ratio: $('#fiRatio').value || '1:1',
    count: Number($('#fiCount').value) || 1,
  };
}

function resetImageForm() {
  $('#fiPrompt').value = '';
  $('#fiTemplate').value = '';
  $('#fiCount').value = '1';
  $('#fiSize').selectedIndex = 0;
  $('#fiRatio').selectedIndex = 0;
}

function switchMode(mode) {
  $$('#modeTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#grpKeyframe').classList.toggle('hidden', mode !== 'keyframe');
  $('#grpReference').classList.toggle('hidden', mode !== 'reference');
  const hint = $('#mediaHint');
  if (mode === 'text') hint.textContent = '纯文本模式：不携带任何媒体素材。';
  if (mode === 'keyframe')
    hint.textContent = '首帧/尾帧控制：至少提供一个图片 URL，生成结果会尽量保持为成片的真实首/尾帧。';
  if (mode === 'reference')
    hint.textContent =
      '多模态参考：素材作为内容/风格/节奏参考，提示词中用 <Picture 1>、<Audio 1>、<Video 1> 指代（从 1 编号）。';
}

function renderRefList(key) {
  const el = $('#ref' + key.charAt(0).toUpperCase() + key.slice(1));
  el.innerHTML = refState[key]
    .map((v, i) => {
      const extra =
        key === 'videos' && typeof v === 'object'
          ? `<input type="number" data-i="${i}" data-f="start" placeholder="start_seconds" value="${Number(v.start_seconds) || 0}" style="max-width:90px" />`
          : '';
      const url = typeof v === 'string' ? v : v.url;
      return `<div class="list-row">
          <input type="text" data-i="${i}" value="${esc(url)}" placeholder="https://... ${key === 'videos' ? '(支持字符串或对象)' : ''}" />
          ${extra}
          <button class="rm" type="button" data-i="${i}" data-key="${key}">✕</button>
        </div>`;
    })
    .join('');
}

function syncRefsFromDom() {
  $$('#grpReference .list-row').forEach((row) => {
    const key = row.querySelector('.rm').dataset.key;
    const i = Number(row.querySelector('.rm').dataset.i);
    const url = row.querySelector('input[type=text]').value.trim();
    const start = row.querySelector('input[data-f=start]')?.value;
    if (key === 'videos') {
      refState.videos[i] =
        start !== undefined && start !== '' ? { url, start_seconds: Number(start) || 0, require_audio: false } : url;
    } else {
      refState[key][i] = url;
    }
  });
}

async function submitTask() {
  const btn = $('#btnSubmitTask');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    // P1：按当前表单类型分流（视频 → /api/tasks；图片 → /api/images/tasks）
    let t;
    if (taskType === 'image') {
      if (!$('#fiPrompt').value.trim()) throw new Error('请填写图片描述 prompt');
      t = await api('/api/images/tasks', { method: 'POST', body: collectImageBody() });
      toast(`图片任务 #${t.id} 已入队，生成完成后在列表中查看`, 'ok');
    } else {
      const body = collectBody();
      // 客户端本地校验（对齐 services/payloads.js 的服务端规则，避免提交后才报错）
      if (!body.prompt) throw new Error('请填写视频提示词 prompt');
      if (body.mode === 'keyframe' && !body.first_frame && !body.last_frame)
        throw new Error('首尾帧模式需要至少提供一个首帧或尾帧 URL');
      if (body.mode === 'reference' && !body.images.length && !body.audios.length && !body.videos.length)
        throw new Error('参考模式需要至少提供一类参考素材（图片/音频/视频）');
      t = await api('/api/tasks', { method: 'POST', body });
      toast(`任务 #${t.id} 已提交（video_id: ${t.video_id || '-'}）`, 'ok');
    }
    // 表单内容由下次 openNewTask 统一重置（与「取消关闭即清空」保持一致）
    $('#newTaskModal').hidden = true;
    bus.emit('tasks-changed');
  } catch (e) {
    toast('提交失败：' + e.message, 'err');
    bus.emit('tasks-changed'); // 失败也刷新列表，让 submit_error 任务立即显示
  } finally {
    btn.disabled = false;
    btn.textContent = '提交任务';
  }
}

function collectBody() {
  const mode = $('#modeTabs .tab.active').dataset.mode;
  syncRefsFromDom();
  const body = {
    model: $('#fModel').value,
    prompt: $('#fPrompt').value.trim(),
    mode,
    seconds: $('#fSeconds').value,
    size: $('#fSize').value,
    aspect_ratio: $('#fAspect').value,
    seed: $('#fSeed').value === '' ? null : Number($('#fSeed').value),
  };
  if (mode === 'keyframe') {
    body.first_frame = $('#fFirstFrame').value.trim() || undefined;
    body.last_frame = $('#fLastFrame').value.trim() || undefined;
  }
  if (mode === 'reference') {
    body.images = refState.images.filter(Boolean);
    body.audios = refState.audios.filter(Boolean);
    // 视频行是对象 {url,…}，需按 url 过滤空行（filter(Boolean) 对对象恒真拦不住空 URL）
    body.videos = refState.videos.filter((v) => (typeof v === 'string' ? v : v && v.url));
  }
  return body;
}

function resetNewTaskModal() {
  // 视频表单内容回默认（时长/画幅/参考素材/种子）
  $('#fPrompt').value = '';
  $('#fSeed').value = '';
  $('#fFirstFrame').value = '';
  $('#fLastFrame').value = '';
  $('#fTemplate').value = '';
  $('#fSeconds').value = '5';
  $('#fAspect').value = '16:9';
  refState.images = [];
  refState.audios = [];
  refState.videos = [];
  renderRefList('images');
  renderRefList('audios');
  renderRefList('videos');
  resetImageForm();
  // 模型回默认免费项
  const dm = DEFAULT_MODEL();
  if ($('#fModel').value !== dm) {
    $('#fModel').value = dm;
    onModelChange();
  }
  // 任务类型与生成模式页签回默认（视频 + text）
  switchTaskType('video');
  $$('#modeTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === 'text'));
  switchMode('text');
}

/* ---------------- 模板 ---------------- */
const TEMPLATES = {
  'text-city': {
    model: 'agnes-video-2.5-flash',
    mode: 'text',
    prompt: '雨后的未来城市街道，霓虹灯倒映在地面，一辆银色跑车缓慢驶过，电影级运镜，自然环境声',
  },
  'text-cats': {
    model: 'agnes-video-2.5-flash',
    mode: 'text',
    prompt: '夜晚森林中三只猫组成微型铜管乐队向前行进，镜头平稳后退，月光穿过树叶，自然脚步声与乐器声',
  },
  'text-ocean': {
    model: 'agnes-video-2.5-flash',
    mode: 'text',
    prompt: '航拍镜头缓缓掠过翡翠色海面，白色浪花在礁石上翻卷，阳光透过云层洒下，海鸥鸣叫，写实风格',
  },
  'keyframe-walk': {
    model: 'agnes-video-2.5-flash',
    mode: 'keyframe',
    prompt: '人物从首帧姿态自然转身走向窗边，衣物和头发运动真实，镜头缓慢推进，平滑过渡到尾帧构图',
  },
  'ref-character': {
    model: 'agnes-video-2.5-flash',
    mode: 'reference',
    prompt: '以 <Picture 1> 中的角色和美术风格为参考，角色在花田中自然奔跑，保持外观一致，低机位跟拍',
  },
  'ref-audio': {
    model: 'agnes-video-2.5-flash',
    mode: 'reference',
    prompt: '以 <Picture 1> 为视觉主体，根据 <Audio 1> 的节奏设计动作和镜头切换，保持自然连贯',
  },
  'ref-video': {
    model: 'agnes-video-2.5',
    mode: 'reference',
    prompt: '参考 <Video 1> 的主体动作和镜头节奏，将场景改为月光下的卧室，同时保持时序连贯',
  },
};

/* P1：图片任务示例模板 */
const IMAGE_TEMPLATES = {
  'img-cat': '一只橘色虎斑猫趴在洒满阳光的窗台上打盹，窗外是虚化的城市街景，温暖逆光，浅景深特写，胶片质感，高细节',
  'img-landscape': '晨雾笼罩的雪山与山脚湖泊，水面倒映粉色朝霞，前景几棵墨绿松树，超广角风光摄影，国家地理风格',
  'img-portrait':
    '古风少女半身像，青色汉服银色步摇，发丝随风轻扬，柔和侧逆光，浅景深，工笔画与写实结合风格，细腻肌肤质感',
  'img-product': '极简风格产品静物：磨砂玻璃香水瓶置于浅灰石板上，一束柔和顶光，大面积留白，商业摄影质感',
};

function applyTemplate(key) {
  const t = TEMPLATES[key];
  if (!t) return;
  if (t.model && t.model !== $('#fModel').value) {
    $('#fModel').value = t.model;
    onModelChange();
  }
  switchMode(t.mode);
  $$('#modeTabs .tab').forEach((el) => el.classList.toggle('active', el.dataset.mode === t.mode));
  $('#fPrompt').value = t.prompt;
}

/* ---------------- P1：AI 优化提示词（视频/图片通用，系统提示词可覆盖） ---------------- */
const VIDEO_OPTIMIZE_SYSTEM =
  '你是视频生成提示词优化器。把用户零散的想法改写为一条可直接用于 AI 视频生成的专业提示词，150~220 字，六段式按序书写：主体与场景（外观与空间具体化）→ 动作与变化（2~3 个有先后顺序的连续动作）→ 镜头语言（景别 + 运镜 + 转场）→ 光线与色调（时段、光源方向、色温）→ 视觉风格与画质 → 声音与节奏。规则：把抽象词替换为可视细节；不得增加用户未提及的新主体；保留用户原意与全部关键元素；只输出优化后的提示词本身，不要任何解释、前缀或引号。';

async function runAiOptimize(opts = {}) {
  const promptEl = $(opts.promptEl || '#fPrompt');
  const idea = promptEl.value.trim();
  if (!idea) {
    toast('请先填写原始描述', 'err');
    return;
  }
  // 触发按钮（默认视频优化按钮；图片按钮由调用处传入）
  const btn = opts.btn || $('#btnAiOptimize');
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '优化中…';
  try {
    const r = await api('/api/llm/chat', {
      method: 'POST',
      body: {
        system: opts.system || VIDEO_OPTIMIZE_SYSTEM,
        messages: [{ role: 'user', content: idea }],
        temperature: 0.8,
      },
    });
    const adopt = () => {
      promptEl.value = r.content.trim();
      toast('已采用优化后的描述', 'ok');
    };
    if (compare) {
      // 优化结果先对比，由用户决定采用；是否用 AI 优化始终由用户发起
      compare({
        title: opts.title || '提示词优化对比',
        oldLabel: '我的原始描述',
        newLabel: 'AI 优化后',
        oldText: idea,
        newText: r.content,
        onAdopt: adopt,
        onKeep: () => toast('已保留原始描述', 'ok'),
      });
    } else {
      adopt();
    }
  } catch (e) {
    toast('优化失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = btnLabel;
  }
}

/** 装配新建任务弹窗交互（含顶栏「＋ 新建任务」入口与提交按钮） */
function initNewTask() {
  // 选项卡
  $('#modeTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchMode(tab.dataset.mode);
  });
  // P1：任务类型切换（视频 ⇄ 图片）
  $('#taskTypeTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.type-tab');
    if (tab) switchTaskType(tab.dataset.ptype);
  });
  // P1：图片模板应用
  $('#fiTemplate').addEventListener('change', (e) => {
    const p = IMAGE_TEMPLATES[e.target.value];
    if (p) $('#fiPrompt').value = p;
  });
  // 视频示例模板应用（M4-B2：原 index.html inline onchange 引用 window.__app 已删除，改此处绑定）
  $('#fTemplate').addEventListener('change', (e) => applyTemplate(e.target.value));
  // 参考素材行
  $('#grpReference').addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-add]');
    if (addBtn) {
      const key = addBtn.dataset.add;
      refState[key].push(key === 'videos' ? { url: '', start_seconds: 0, require_audio: false } : '');
      renderRefList(key);
      return;
    }
    const rm = e.target.closest('.rm');
    if (rm) {
      const key = rm.dataset.key;
      refState[key].splice(Number(rm.dataset.i), 1);
      renderRefList(key);
    }
  });
  $('#grpReference').addEventListener('input', (e) => {
    const inp = e.target.closest('.list-row input');
    if (inp) syncRefsFromDom();
  });
  ['images', 'audios', 'videos'].forEach(renderRefList);

  // 模型切换
  $('#fModel').addEventListener('change', onModelChange);

  // ✨ AI 优化提示词（调文本模型；视频与图片两套系统提示词）
  $('#btnAiOptimize').addEventListener('click', () => runAiOptimize({ btn: $('#btnAiOptimize') }));
  $('#btnAiOptimizeImage').addEventListener('click', () =>
    runAiOptimize({
      btn: $('#btnAiOptimizeImage'),
      promptEl: '#fiPrompt',
      system:
        '你是图片生成提示词优化器。把用户零散的想法改写为一条可直接用于 AI 绘图的提示词，60~120 字，五段式按序书写：主体与外观（具体到材质、颜色、形态）→ 场景与光线（时段、光源方向、氛围）→ 构图与视角（景别、机位、透视）→ 艺术风格 → 画质细节。规则：把抽象词替换为可视细节；不得增加用户未提及的新主体；保留用户原意与全部关键元素；只输出优化后的提示词本身，不要任何解释、前缀或引号。',
      title: '图片描述优化对比',
    }),
  );

  // 提交与入口按钮
  $('#btnSubmitTask').addEventListener('click', submitTask);
  $('#btnNewTask').addEventListener('click', () => openNewTask(null));

  // 模板下拉
  $('#fTemplate').innerHTML =
    '<option value="">— 选择示例 —</option>' +
    '<optgroup label="2.5 Flash · 文生视频">' +
    '<option value="text-city">未来城市雨夜（跑车）</option>' +
    '<option value="text-cats">猫咪铜管乐队</option>' +
    '<option value="text-ocean">翡翠海面航拍</option></optgroup>' +
    '<optgroup label="2.5 Flash · 首尾帧">' +
    '<option value="keyframe-walk">人物转身走向窗边</option></optgroup>' +
    '<optgroup label="2.5 Flash · 多模态参考">' +
    '<option value="ref-character">角色花田奔跑 &lt;Picture 1&gt;</option>' +
    '<option value="ref-audio">音画协同 &lt;Picture 1&gt;+&lt;Audio 1&gt;</option></optgroup>' +
    '<optgroup label="高级（付费 2.5）">' +
    '<option value="ref-video">视频参考 &lt;Video 1&gt;</option></optgroup>';
}

export { initNewTask };
