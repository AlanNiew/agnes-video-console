/* task-center.js —— 任务中心视图与任务详情弹窗（M4-B2：自 app.js 拆出）
 * 时间线列表 / 看板两形态 + 顶栏统计 + 分页 + 视频懒加载 + 任务操作（查询/重试/删除）。
 * 渲染沿用「集合签名」局部更新（lastColSig/lastListSig/lastPageSig/detailSig），避免打断视频播放。
 * 依赖：common.js、state.js（响应 tasks-changed 自刷新）、task-meta.js、settings-panel.js（连接状态渲染）。
 */
import { $, $$, esc, fmtTime, toast, api } from './common.js';
import { bus } from './state.js';
import { modelShort } from './task-meta.js';
import { renderConn } from './settings-panel.js';

// M4-B1-3：任务数据变更信号（workspace/新建任务提交后 emit）→ 刷新任务中心（不切视图）
bus.on('tasks-changed', () => {
  loadTasks();
});

const STATUS_LABEL = {
  queued: '队列中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '失败',
  submit_error: '提交失败',
};
const MODE_LABEL = { text: '文生', keyframe: '首尾帧', reference: '参考', image: '图生', keyframes: '关键帧' };
// P0：任务类型（kind 后端字段 P1 落地，缺省视为视频任务，前端徽章先行就绪）
const KIND_ICON = { video: '🎬', image: '🖼️' };
const KIND_LABEL = { video: '视频', image: '图片' };
const taskKind = (t) => (t.kind === 'image' ? 'image' : 'video');
/** v2.1 来源标签：项目名 / 镜头序号与标题 / 角色图·场景图 / 独立创作（看板与列表共用） */
function taskSourceLabel(t) {
  const kind = taskKind(t);
  const parts = [];
  if (t.project_name) parts.push(`项目「${t.project_name}」`);
  if (kind === 'image') {
    // 图片任务：image_id 指向 project_images（角色图/场景图溯源）
    if (t.image_kind === 'character') parts.push('角色设定图');
    else if (t.image_kind === 'scene') parts.push('场景图');
  } else if (t.shot_seq) {
    parts.push(`镜头 ${t.shot_seq}${t.shot_title ? `「${t.shot_title}」` : ''}`);
  } else if (t.image_kind === 'character' && t.project_name) {
    parts.push('引用角色图');
  }
  if (!parts.length) parts.push(t.project_id ? `项目 #${t.project_id}` : '独立创作');
  return parts.join(' · ');
}

const state = {
  tasks: [],
  search: '',
  statusFilter: '',
  page: 1, // P0：当前页码（1 起，筛选/搜索变更时重置）
  pageSize: 20, // P0：每页条数
  total: 0, // P0：满足当前筛选的总条数（后端返回）
  viewMode: 'list', // P0：任务中心视图（list=时间线列表 / board=看板）
  lastColSig: {}, // 列签名，避免无谓重建（防止视频播放被打断）
  lastListSig: null, // P0：列表行集合签名（同上）
  lastPageSig: null, // P0：分页条签名
  detailSig: null,
  detailId: null,
};

/* ---------------- 工具 ---------------- */
function relTime(ts) {
  if (!ts) return '-';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

/* ---------------- 统计栏 ---------------- */
function renderStats(s) {
  if (!s) return;
  const b = s.byStatus || {};
  $('#statTotal').textContent = s.total;
  $('#statQueued').textContent = b.queued || 0;
  $('#statActive').textContent = b.in_progress || 0;
  $('#statDone').textContent = b.completed || 0;
  $('#statFailed').textContent = (b.failed || 0) + (b.submit_error || 0);
  $('#cntQueued').textContent = b.queued || 0;
  $('#cntActive').textContent = b.in_progress || 0;
  $('#cntDone').textContent = b.completed || 0;
  $('#cntFailed').textContent = (b.failed || 0) + (b.submit_error || 0);
}

/* ---------------- 卡片 ---------------- */
function cardHTML(t) {
  const kind = taskKind(t);
  const req = t.request_json || {};
  const metas =
    kind === 'image'
      ? [t.size, t.aspect_ratio, `${(t.images || []).length || Number(req.count) || 1} 张`, modelShort(t.model)].filter(
          Boolean,
        )
      : [
          MODE_LABEL[t.mode] || t.mode,
          t.seconds ? `${t.seconds}s` : null,
          t.aspect_ratio,
          t.size,
          modelShort(t.model),
          t.seed !== null && t.seed !== undefined ? `seed ${t.seed}` : null,
          t.video_id ? t.video_id.slice(-10) : null,
        ].filter(Boolean);
  const metaHtml = metas.map((m) => `<span class="meta-tag">${esc(m)}</span>`).join('');
  const mediaN = kind === 'image' ? 0 : (t.images?.length || 0) + (t.audios?.length || 0) + (t.videos?.length || 0);

  let extra = '';
  if (t.status === 'in_progress') {
    extra = `<div class="pbar"><div style="width:${Math.max(2, Number(t.progress) || 0)}%"></div></div>`;
  }
  const playSrc = t.video_local_url || t.metadata_url; // v1.3：本地归档优先（远端链接会过期）
  if (kind === 'image' && t.status === 'completed' && (t.images || []).length) {
    // P1：图片任务看板缩略图墙
    extra = `<div class="img-preview-row">${t.images
      .map(
        (im) =>
          `<a href="${esc(im.local_url || im.remote_url)}" target="_blank" rel="noopener" title="查看/下载原图"><img src="${esc(im.local_url || im.remote_url)}" loading="lazy" alt="生成图片" /></a>`,
      )
      .join('')}</div>`;
  } else if (t.status === 'completed' && playSrc) {
    extra = `
        <div class="video-preview" title="点击查看详情播放">
          <video muted playsinline preload="metadata" data-src="${esc(playSrc)}"></video>
          <div class="vp-overlay"><span class="vp-play">▶</span></div>
          ${t.seconds ? `<span class="vp-dur">${esc(t.seconds)}s</span>` : ''}
        </div>`;
  }
  if (t.status === 'failed' || t.status === 'submit_error') {
    extra = `
        <details class="card-error"><summary>错误详情</summary><div>${esc(t.error_message || '未知错误')}</div></details>`;
  }

  const actions = [];
  actions.push(`<button class="act" data-act="detail">详情</button>`);
  if (t.video_id) actions.push(`<button class="act" data-act="poll">立即查询</button>`);
  if (t.status === 'completed' && playSrc) {
    actions.push(
      `<a class="act green" href="${esc(playSrc)}" target="_blank" rel="noopener">下载${t.video_local_url ? '' : ''}</a>`,
    );
  }
  if (t.status === 'failed' || t.status === 'submit_error') {
    actions.push(`<button class="act" data-act="retry">重试</button>`);
  }
  actions.push(`<button class="act red" data-act="del">删除</button>`);

  return `
      <article class="card status-${t.status}" data-id="${t.id}">
        <div class="card-top">
          <span class="badge">${kind === 'image' ? '🖼️ 图片' : '🎬 ' + esc(MODE_LABEL[t.mode] || t.mode)}</span>
          <span class="badge">${esc(t.size || '-')}</span>
          <span class="card-id">#${t.id}</span>
          ${t.superseded ? '<span class="badge" style="opacity:.65" title="该镜头已有更新成功的任务，此失败记录仅供参考">已作废</span>' : ''}
          ${t.retry_count ? `<span class="badge" style="opacity:.75" title="该任务已手动重试过 ${t.retry_count} 次">已重试×${t.retry_count}</span>` : ''}
          ${mediaN ? `<span class="badge" title="参考素材数">素材×${mediaN}</span>` : ''}
          <span class="card-time" title="${fmtTime(t.created_at)}">${relTime(t.created_at)}</span>
        </div>
        <div class="card-src" title="${esc(taskSourceLabel(t))}">📁 ${esc(taskSourceLabel(t))}</div>
        <div class="card-prompt" title="${esc(t.prompt)}">${esc(t.prompt)}</div>
        <div class="card-meta">${metaHtml}</div>
        ${extra}
        <div class="card-actions">${actions.join('')}</div>
      </article>`;
}

function columnSig(status, tasks) {
  // 已完成列只对“任务集合 + 结果”敏感，忽略轮询计数，避免打断播放
  return JSON.stringify(
    tasks.map((t) =>
      t.status === 'completed'
        ? [t.id, t.status, t.metadata_url, t.video_local_url]
        : [t.id, t.status, t.progress, t.video_id, t.error_message],
    ),
  );
}

/* ---------------- P0：时间线列表（默认视图） ---------------- */
/** 紧凑任务行：类型徽章 + 状态徽章 + prompt 摘要 + 规格 + 相对时间 + 操作 */
function rowHTML(t) {
  const kind = taskKind(t);
  const req = t.request_json || {};
  const metas =
    kind === 'image'
      ? [t.size, t.aspect_ratio, `${(t.images || []).length || Number(req.count) || 1} 张`, modelShort(t.model)].filter(
          Boolean,
        )
      : [
          MODE_LABEL[t.mode] || t.mode,
          t.seconds ? `${t.seconds}s` : null,
          t.aspect_ratio,
          t.size,
          modelShort(t.model),
          t.seed !== null && t.seed !== undefined ? `seed ${t.seed}` : null,
        ].filter(Boolean);
  const metaHtml = metas.map((m) => `<span class="meta-tag">${esc(m)}</span>`).join('');
  const mediaN = kind === 'image' ? 0 : (t.images?.length || 0) + (t.audios?.length || 0) + (t.videos?.length || 0);
  const playSrc = t.video_local_url || t.metadata_url;

  // 状态徽章：生成中带迷你进度条，其余纯文本徽章
  let statusHtml;
  if (t.status === 'in_progress') {
    const pct = Math.max(2, Number(t.progress) || 0);
    statusHtml = `<span class="chip-mini in_progress t-st">${pct}%</span><div class="t-pbar"><div style="width:${pct}%"></div></div>`;
  } else {
    statusHtml = `<span class="chip-mini ${t.status} t-st">${esc(STATUS_LABEL[t.status] || t.status)}</span>`;
  }

  // 失败行：错误摘要单行截断（完整信息看详情）
  const errHtml =
    t.status === 'failed' || t.status === 'submit_error'
      ? `<div class="t-err" title="${esc(t.error_message || '未知错误')}">⚠ ${esc(t.error_message || '未知错误')}</div>`
      : '';

  const actions = [];
  actions.push(`<button class="act" data-act="detail">详情</button>`);
  if (t.video_id) actions.push(`<button class="act" data-act="poll">查询</button>`);
  if (t.status === 'completed' && playSrc) {
    actions.push(`<a class="act green" href="${esc(playSrc)}" target="_blank" rel="noopener">下载</a>`);
  }
  if (t.status === 'failed' || t.status === 'submit_error') {
    actions.push(`<button class="act" data-act="retry">重试</button>`);
  }
  actions.push(`<button class="act red" data-act="del">删除</button>`);

  return `
      <article class="task-row status-${t.status}" data-id="${t.id}">
        <span class="t-kind" title="${esc(KIND_LABEL[kind])}任务">${KIND_ICON[kind]}</span>
        <div class="t-status">${statusHtml}</div>
        <div class="t-main">
          <div class="t-src" title="${esc(taskSourceLabel(t))}">📁 ${esc(taskSourceLabel(t))}${t.retry_count ? ` · <span class="t-retry" title="该任务已手动重试过 ${t.retry_count} 次">已重试×${t.retry_count}</span>` : ''}</div>
          <div class="t-prompt" title="${esc(t.prompt)}">${esc(t.prompt)}</div>
          <div class="t-metas">
            <span class="card-id">#${t.id}</span>
            ${t.superseded ? '<span class="meta-tag" title="该镜头已有更新成功的任务，此失败记录仅供参考">已作废</span>' : ''}
            ${mediaN ? `<span class="meta-tag" title="参考素材数">素材×${mediaN}</span>` : ''}
            ${metaHtml}
          </div>
          ${errHtml}
        </div>
        <div class="t-side">
          <span class="t-time" title="${fmtTime(t.created_at)}">${relTime(t.created_at)}</span>
          <div class="t-actions">${actions.join('')}</div>
        </div>
      </article>`;
}

function updateEmptyTip() {
  const emptyEl = $('#emptyTip');
  emptyEl.hidden = state.tasks.length > 0;
  if (!emptyEl.hidden) {
    emptyEl.querySelector('h3').textContent = state.search
      ? `没有匹配「${state.search}」的任务`
      : state.statusFilter
        ? `暂无${STATUS_LABEL[state.statusFilter] || '该状态'}任务`
        : '还没有任务';
  }
}

function renderTaskList() {
  const sig = columnSig('list', state.tasks);
  const rowsEl = $('#taskRows');
  if (state.lastListSig !== sig) {
    state.lastListSig = sig;
    rowsEl.innerHTML = state.tasks.length
      ? state.tasks.map(rowHTML).join('')
      : '<div class="muted" style="text-align:center;padding:26px 0;font-size:12px">本页暂无任务</div>';
  }
  updateEmptyTip();
}

/** 分页条（含每页条数选择）；仅签名的页码信息变化时重建，按钮状态实时更新 */
function renderPagination() {
  const el = $('#pagination');
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const sig = JSON.stringify([state.page, state.total, state.pageSize]);
  if (state.lastPageSig !== sig) {
    state.lastPageSig = sig;
    el.innerHTML = `
        <button class="pg-btn" data-pg="prev">← 上一页</button>
        <span class="pg-info">第 <b>${state.page}</b> / ${totalPages} 页 · 共 ${state.total} 条</span>
        <button class="pg-btn" data-pg="next">下一页 →</button>
        <select class="pg-size" title="每页条数">
          <option value="10" ${state.pageSize === 10 ? 'selected' : ''}>每页 10 条</option>
          <option value="20" ${state.pageSize === 20 ? 'selected' : ''}>每页 20 条</option>
          <option value="50" ${state.pageSize === 50 ? 'selected' : ''}>每页 50 条</option>
        </select>`;
    // 绑定事件（重建时整体替换，闭包安全）
    el.querySelector('[data-pg=prev]').onclick = () => changePage(state.page - 1);
    el.querySelector('[data-pg=next]').onclick = () => changePage(state.page + 1);
    el.querySelector('.pg-size').onchange = (e) => {
      state.pageSize = Number(e.target.value) || 20;
      state.page = 1;
      loadTasks();
    };
  }
  // 按钮可用态不参与签名（避免整条重建吃掉点击）
  el.querySelector('[data-pg=prev]').disabled = state.page <= 1;
  el.querySelector('[data-pg=next]').disabled = state.page >= totalPages;
}

function changePage(p) {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const np = Math.min(Math.max(1, p), totalPages);
  if (np === state.page) return;
  state.page = np;
  loadTasks();
  // 翻页后回到列表顶部
  $('#taskListView').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 列表 ⇄ 看板 视图切换（列表为默认；看板保留富媒体卡片形态） */
function switchTaskView(mode) {
  state.viewMode = mode === 'board' ? 'board' : 'list';
  $('#taskListView').hidden = state.viewMode !== 'list';
  $('#board').hidden = state.viewMode !== 'board';
  $$('#viewToggle .vt-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.viewMode));
  // 看板需要重渲染（可能刚从列表切回且数据已变化）
  if (state.viewMode === 'board') renderBoard();
  else renderTaskList();
}

function renderBoard() {
  const byCol = { queued: [], in_progress: [], completed: [], failed: [] };
  for (const t of state.tasks) {
    if (t.status === 'failed' || t.status === 'submit_error') byCol.failed.push(t);
    else if (byCol[t.status]) byCol[t.status].push(t);
    else byCol.failed.push(t); // 未知状态兜底
  }
  // 状态筛选：选中某状态时只显示该列（单列聚焦视图），「全部」显示四列
  const filter = state.statusFilter;
  const map = {
    queued: '#colQueued',
    in_progress: '#colActive',
    completed: '#colDone',
    failed: '#colFailed',
  };
  let hasAny = false;
  for (const col of Object.keys(byCol)) {
    const colEl = document.querySelector(`.col[data-col="${col}"]`);
    const isShown = !filter || col === filter;
    if (colEl) colEl.classList.toggle('col-hidden', !isShown);
    if (byCol[col].length) hasAny = true;
    const sig = columnSig(col, byCol[col]);
    if (state.lastColSig[col] === sig) continue;
    state.lastColSig[col] = sig;
    const el = $(map[col]);
    el.innerHTML = byCol[col].length
      ? byCol[col].map(cardHTML).join('')
      : '<div class="muted" style="text-align:center;padding:18px 0;font-size:12px">暂无任务</div>';
  }
  $('#board').classList.toggle('focus', Boolean(filter));
  updateEmptyTip();
  observeVideos();
}

/* ---------------- 视频懒加载（IntersectionObserver） ---------------- */
let videoObserver = null;
function observeVideos() {
  // P0：看板与列表两个视图容器内的视频统一懒加载
  const videos = document.querySelectorAll('#board video[data-src], #taskListView video[data-src]');
  if (!videos.length) return;
  if ('IntersectionObserver' in window) {
    if (!videoObserver) {
      videoObserver = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const v = en.target;
            if (!v.src) {
              v.src = v.dataset.src;
              // 元数据加载成功后，用真实时长替换角标（如 5.04s → 5s）
              v.addEventListener(
                'loadedmetadata',
                () => {
                  const dur = v.closest('.video-preview')?.querySelector('.vp-dur');
                  if (dur && Number.isFinite(v.duration) && v.duration > 0)
                    dur.textContent = `${Math.round(v.duration)}s`;
                },
                { once: true },
              );
            }
            videoObserver.unobserve(v);
          }
        },
        { rootMargin: '180px' },
      );
    }
    videos.forEach((v) => {
      if (!v.src) videoObserver.observe(v);
    });
  } else {
    // 不支持 IntersectionObserver 的浏览器：直接加载
    videos.forEach((v) => {
      if (!v.src) v.src = v.dataset.src;
    });
  }
}

/* ---------------- 数据加载 ---------------- */
let loadFailCount = 0;

async function loadTasks() {
  try {
    // P0 分页：limit=每页条数，offset=(页码-1)*每页条数；轮询时保持页码与筛选不变
    const params = new URLSearchParams({
      limit: String(state.pageSize),
      offset: String((state.page - 1) * state.pageSize),
    });
    if (state.statusFilter) params.set('status', state.statusFilter);
    if (state.search) params.set('q', state.search);
    const data = await api(`/api/tasks?${params}`);
    state.tasks = data.items;
    state.total = Number(data.total) || 0;
    // 页码越界回退：筛选清理/批量删除导致当前页超出范围时，回到最后一页（只回退一次，防循环）
    if (!state.tasks.length && state.total > 0 && state.page > 1) {
      state.page = Math.ceil(state.total / state.pageSize);
      return loadTasks();
    }
    renderStats(data.stats);
    if (state.viewMode === 'board') renderBoard();
    else {
      renderTaskList();
      renderPagination();
    }
    if (loadFailCount > 0) {
      loadFailCount = 0;
      renderConn(true);
      toast('连接已恢复', 'ok');
    }
  } catch (e) {
    loadFailCount += 1;
    renderConn(false);
    // 首次失败提示一次，之后每 30 秒（15 个轮询周期）提醒一次，避免刷屏
    if (loadFailCount === 1 || loadFailCount % 15 === 0) toast(`任务刷新失败：${e.message}`, 'err');
  }
}

/* ---------------- 任务操作 ---------------- */
async function act(id, name, fn) {
  try {
    const r = await fn();
    toast(r && typeof r === 'string' ? `${name}成功：${r}` : `${name}成功`, 'ok');
    await loadTasks();
  } catch (e) {
    toast(`${name}失败：${e.message}`, 'err');
  }
}

/** 任务行/卡片交互（列表与看板共用同一套 data-act 协议） */
function bindTaskEvents(container) {
  container.addEventListener('click', async (ev) => {
    const vp = ev.target.closest('.video-preview');
    const btn = ev.target.closest('[data-act]');
    if (!btn) {
      // 点击视频预览（或卡片其余区域仅当点击预览）→ 打开详情播放
      if (vp) {
        const card = vp.closest('.card, .task-row');
        if (card) openDetail(Number(card.dataset.id));
      }
      return;
    }
    const card = ev.target.closest('.card, .task-row');
    if (!card) return;
    const id = Number(card.dataset.id);
    const actName = btn.dataset.act;
    if (actName === 'detail') return openDetail(id);
    if (actName === 'poll')
      return act(id, '查询', async () => (await api(`/api/tasks/${id}/poll`, { method: 'POST' })).status);
    if (actName === 'retry') {
      if (confirm(`重新提交任务 #${id}？该任务将重新排队（队列中 → 生成中 → 完成/失败），任务编号不变。`)) {
        await act(id, '重试', async () => {
          const r = await api(`/api/tasks/${id}/retry`, { method: 'POST' });
          return `任务 #${r.task.id} 已重新排队（第 ${r.task.retry_count} 次重试）`;
        });
      }
      return;
    }
    if (actName === 'del') {
      if (confirm(`确认删除任务 #${id}？`)) {
        await act(id, '删除', () => api(`/api/tasks/${id}`, { method: 'DELETE' }));
        if (state.detailId === id) closeDetail();
      }
      return;
    }
    if (actName === 'video') return; // 视频本身可点击播放
  });
}

/* ---------------- 卡片点击 → 详情 ---------------- */
function openDetail(id) {
  state.detailId = id;
  state.detailSig = null;
  $('#detailActions').dataset.sig = ''; // 强制重建操作栏，保证按钮闭包绑定当前任务
  $('#detailModal').hidden = false;
  refreshDetail();
}
function closeDetail() {
  state.detailId = null;
  state.detailSig = null;
  $('#detailActions').dataset.sig = '';
  $('#detailModal').hidden = true;
}

function jsonBox(obj) {
  return `<pre class="jsonbox">${esc(JSON.stringify(obj, null, 2))}</pre>`;
}
function dlRow(k, v, cls = '') {
  return `<dt>${esc(k)}</dt><dd class="${cls}">${v === null || v === undefined || v === '' ? '<span class="muted">-</span>' : esc(v)}</dd>`;
}

async function refreshDetail() {
  const id = state.detailId;
  if (!id) return;
  let t;
  try {
    t = await api(`/api/tasks/${id}`);
  } catch (e) {
    // 任务已被删除（如「清空已完成/失败」）→ 自动关闭弹窗，避免静默 404
    if (e.status === 404) closeDetail();
    return;
  }
  const body = $('#detailBody');
  const sig = JSON.stringify([id, t.status, t.progress, t.metadata_url, t.video_local_url, t.error_message]);
  if (state.detailSig === sig && body.dataset.rendered === '1') {
    // 内容未变化，不重建（避免打断视频）
  } else {
    state.detailSig = sig;

    const kind = taskKind(t);
    const playSrc = t.video_local_url || t.metadata_url; // v1.3：本地归档优先
    let play = '';
    if (kind === 'image' && t.status === 'completed' && (t.images || []).length) {
      // P1：图片任务产物墙（点击新窗口查看原图，右键/详情页可下载）
      play = `<div class="detail-image-wall">${t.images
        .map(
          (im) => `
          <a href="${esc(im.local_url || im.remote_url)}" target="_blank" rel="noopener" title="查看/下载原图">
            <img src="${esc(im.local_url || im.remote_url)}" loading="lazy" alt="生成图片" />
          </a>`,
        )
        .join('')}</div>`;
    } else if (t.status === 'completed' && playSrc) {
      play = `<div class="detail-body-play"><video controls preload="metadata" src="${esc(playSrc)}"></video></div>`;
    }

    const req = t.request_json || {};
    const mediaRows = [];
    if (kind !== 'image') {
      // 视频任务的参考素材；图片任务的 images 列是生成结果（见产物墙），不走这里
      ['images', 'audios', 'videos'].forEach((k) => {
        const arr = t[k] || [];
        arr.forEach((v, i) => {
          const label = { images: 'Picture', audios: 'Audio', videos: 'Video' }[k];
          const url = typeof v === 'string' ? v : v?.url;
          mediaRows.push(dlRow(`<${label} ${i + 1}>`, url, 'url'));
        });
      });
    }

    body.innerHTML = `
        <div class="detail-section">
          <div class="progress-big">
            <b>${t.status === 'in_progress' ? `${Number(t.progress) || 0}%` : esc(STATUS_LABEL[t.status] || t.status)}</b>
            ${t.status === 'in_progress' ? `<div class="pbar"><div style="width:${Math.max(2, Number(t.progress) || 0)}%"></div></div>` : ''}
          </div>
          ${play}
          <div class="detail-dl">
            ${dlRow('ID', '#' + t.id)}
            ${dlRow('类型', kind === 'image' ? '图片任务' : '视频任务')}
            ${dlRow('来源', taskSourceLabel(t))}
            ${dlRow('状态', STATUS_LABEL[t.status] || t.status)}
            ${t.retry_count ? dlRow('重试次数', `已重试 ${t.retry_count} 次`) : ''}
            ${kind === 'image' ? '' : dlRow('模式', (MODE_LABEL[t.mode] || t.mode) + '（' + t.mode + '）')}
            ${dlRow('模型', t.model)}
            ${dlRow('提示词', t.prompt)}
            ${kind === 'image' ? dlRow('张数', `${(t.images || []).length || Number(req.count) || 1} 张`) : ''}
            ${kind === 'image' ? '' : dlRow('时长', t.seconds + 's')}
            ${dlRow('画幅', t.aspect_ratio)}
            ${dlRow('分辨率', t.size)}
            ${kind === 'image' ? '' : dlRow('种子 seed', t.seed === null ? '' : t.seed)}
            ${kind === 'image' ? '' : dlRow('num_frames / frame_rate', (t.num_frames ?? '-') + ' / ' + (t.frame_rate ?? '-'))}
            ${t.image ? dlRow('图生图片 image', t.image, 'url') : ''}
            ${t.negative_prompt ? dlRow('反向提示词 negative_prompt', t.negative_prompt) : ''}
            ${dlRow('创建时间', fmtTime(t.created_at) + '（' + relTime(t.created_at) + '）')}
            ${dlRow('完成时间', fmtTime(t.completed_at))}
            ${kind === 'image' ? dlRow('项目', t.project_id ? `#${t.project_id}` : '独立创作') : ''}
            ${kind === 'image' ? '' : dlRow('task_id / video_id', (t.task_id || '-') + ' / ' + (t.video_id || '-'))}
            ${kind === 'image' ? '' : dlRow('轮询次数', t.poll_count + ' 次' + (t.last_polled_at ? `（最后 ${relTime(t.last_polled_at)}）` : ''))}
            ${t.video_local_url ? dlRow('本地归档', t.video_local_url, 'url') : ''}
            ${dlRow(kind === 'image' ? '图片地址' : '视频地址', t.metadata_url, 'url')}
            ${t.error_message ? dlRow('错误信息', t.error_message) : ''}
            ${mediaRows.join('')}
          </div>
        </div>
        <div class="detail-section"><h4>提交请求（request_json）</h4>${jsonBox(req)}</div>
        ${kind === 'image' ? '' : `<div class="detail-section"><h4>最近一次查询响应</h4>${jsonBox(t.last_poll_response)}</div>`}
        ${t.submit_response ? `<div class="detail-section"><h4>创建任务响应</h4>${jsonBox(t.submit_response)}</div>` : ''}
      `;
    body.dataset.rendered = '1';
  }

  // 操作栏：仅按钮集合变化时重建，避免每 2s 替换节点吃掉点击
  const acts = [];
  if (t.video_id) acts.push(`<button class="btn ghost" id="dPoll">立即查询</button>`);
  if (t.status === 'failed' || t.status === 'submit_error')
    acts.push(`<button class="btn primary" id="dRetry">重试（重新排队）</button>`);
  if (t.status === 'completed' && (t.video_local_url || t.metadata_url)) {
    const dl = t.video_local_url || t.metadata_url;
    acts.push(
      `<a class="btn primary" href="${esc(dl)}" target="_blank" rel="noopener">${taskKind(t) === 'image' ? '下载原图' : '下载视频'}</a>`,
    );
  }
  acts.push(`<button class="btn ghost danger" id="dDel">删除任务</button>`);
  const actsSig = acts.join('|');
  if ($('#detailActions').dataset.sig !== actsSig) {
    $('#detailActions').dataset.sig = actsSig;
    $('#detailActions').innerHTML = acts.join('') + `<button class="btn ghost" data-close>关闭</button>`;

    $('#dStatus').textContent = STATUS_LABEL[t.status] || t.status;
    $('#dStatus').className = `chip-mini ${t.status}`;

    const bind = (idBtn, fn) => {
      const el = $('#' + idBtn);
      if (el) el.onclick = fn;
    };
    bind('dPoll', async () => {
      try {
        const r = await api(`/api/tasks/${id}/poll`, { method: 'POST' });
        toast(`查询完成：${STATUS_LABEL[r.status] || r.status}`, 'ok');
        await refreshDetail();
        await loadTasks();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    bind('dRetry', async () => {
      if (!confirm(`重新提交任务 #${id}？该任务将重新排队（队列中 → 生成中 → 完成/失败），任务编号不变。`)) return;
      try {
        const r = await api(`/api/tasks/${id}/retry`, { method: 'POST' });
        toast(`任务 #${r.task.id} 已重新排队（第 ${r.task.retry_count} 次重试）`, 'ok');
        await refreshDetail();
        await loadTasks();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    bind('dDel', async () => {
      if (!confirm(`确认删除任务 #${id}？`)) return;
      try {
        await api(`/api/tasks/${id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        closeDetail();
        await loadTasks();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  } else {
    $('#dStatus').textContent = STATUS_LABEL[t.status] || t.status;
    $('#dStatus').className = `chip-mini ${t.status}`;
  }
}

/** 当前任务中心视图模式（list/board）——供 app 装配层在切换主视图时决定隐藏哪个容器 */
const getViewMode = () => state.viewMode;

/** 装配任务中心交互（清空按钮 / 搜索 / 状态筛选 / 视图切换 / 事件委托 / 悬停播放） */
function initTaskCenter() {
  $('#btnClearDone').addEventListener('click', async () => {
    if (!confirm('确认删除全部已完成任务？')) return;
    try {
      const r = await api('/api/tasks/bulk/clear-completed', { method: 'POST' });
      toast(`已清理 ${r.removed} 条`, 'ok');
      if (state.detailId) refreshDetail(); // 被清空的任务若是当前打开的详情，触发 404 自动关闭
      loadTasks();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $('#btnClearFailed').addEventListener('click', async () => {
    if (!confirm('确认删除全部失败/提交失败任务？')) return;
    try {
      const r = await api('/api/tasks/bulk/clear-failed', { method: 'POST' });
      toast(`已清理 ${r.removed} 条`, 'ok');
      if (state.detailId) refreshDetail();
      loadTasks();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  // 搜索 + 状态过滤（变更后回到第 1 页）
  let searchTimer = null;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      state.page = 1;
      loadTasks();
    }, 350);
  });
  $('#statusChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#statusChips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.statusFilter = chip.dataset.status;
    state.page = 1;
    loadTasks();
  });
  // P0：列表 ⇄ 看板 视图切换
  $('#viewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.vt-btn');
    if (btn) switchTaskView(btn.dataset.view);
  });

  bindTaskEvents($('#board'));
  bindTaskEvents($('#taskRows'));
  // 悬停视频预览 → 静音自动播放；移出 → 暂停并回到开头
  $('#board').addEventListener('mouseover', (e) => {
    const v = e.target.closest('#board .video-preview video');
    if (v && v.src && v.readyState >= 1) v.play().catch(() => {});
  });
  $('#board').addEventListener('mouseout', (e) => {
    const v = e.target.closest('#board .video-preview video');
    if (v) {
      v.pause();
      if (v.currentTime > 0.4) v.currentTime = 0;
    }
  });
}

export { loadTasks, refreshDetail, getViewMode, initTaskCenter };
