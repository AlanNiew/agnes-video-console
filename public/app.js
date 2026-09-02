/* Agnes Video 任务控制台 —— 前端逻辑（原生 JS，无依赖） */
(() => {
  'use strict';

  // 公共工具统一来自 common.js（须先于本文件加载）
  const { $, $$, esc, fmtTime, toast, api } = window.__common;

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
  // 模型元数据（GET /api/meta，单一事实来源；加载完成前的静态兜底）
  let META = null;
  const MODEL_NAME_FALLBACK = {
    'agnes-video-2.5-flash': 'Flash',
    'agnes-video-2.5': '2.5',
    'agnes-video-v2.0': 'V2.0（旧）',
  };
  const modelInfo = (id) => META?.models.find((m) => m.id === id) || null;
  const modelShort = (id) => modelInfo(id)?.short || MODEL_NAME_FALLBACK[id] || String(id).replace('agnes-video-', '');
  const selectableModels = () => (META ? META.models.filter((m) => !m.deprecated) : []);
  const DEFAULT_MODEL = () =>
    (selectableModels().find((m) => m.free) || selectableModels()[0])?.id || 'agnes-video-2.5-flash';

  const state = {
    tasks: [],
    stats: null,
    settings: null,
    search: '',
    statusFilter: '',
    taskType: 'video', // P1：新建任务类型（video | image）
    page: 1, // P0：当前页码（1 起，筛选/搜索变更时重置）
    pageSize: 20, // P0：每页条数
    total: 0, // P0：满足当前筛选的总条数（后端返回）
    viewMode: 'list', // P0：任务中心视图（list=时间线列表 / board=看板）
    lastColSig: {}, // 列签名，避免无谓重建（防止视频播放被打断）
    lastListSig: null, // P0：列表行集合签名（同上）
    lastPageSig: null, // P0：分页条签名
    detailSig: null,
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
        ? [
            t.size,
            t.aspect_ratio,
            `${(t.images || []).length || Number(req.count) || 1} 张`,
            modelShort(t.model),
          ].filter(Boolean)
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
        ? [
            t.size,
            t.aspect_ratio,
            `${(t.images || []).length || Number(req.count) || 1} 张`,
            modelShort(t.model),
          ].filter(Boolean)
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
  function renderConn(ok) {
    const sub = $('#brandSub');
    if (!ok) {
      sub.textContent = '连接中断 · 无法访问本地服务，请确认 server.js 是否在运行';
      sub.className = 'brand-sub offline';
      return;
    }
    const s = state.settings;
    if (s && s.api_key_set) {
      sub.textContent = `已连接 · ${s.base_url} · 轮询 ${s.poll_interval_ms}ms · Key ${s.api_key_masked}`;
      sub.className = 'brand-sub online';
    } else {
      sub.textContent = '未连接 · 请先在设置中填写 API Key';
      sub.className = 'brand-sub offline';
    }
  }

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

  /* ---------------- 元数据（模型/画幅/时长单一事实来源） ---------------- */
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

  async function loadSettings() {
    try {
      state.settings = await api('/api/settings');
      renderConn(true);
      $('#keyStatus').textContent = state.settings.api_key_set
        ? `（已保存 ${state.settings.api_key_masked}，留空则不修改）`
        : '（未配置）';
      // 旧模型兜底：设置里的默认模型若已下架，则回退默认免费模型
      const m = selectableModels().some((x) => x.id === state.settings.model) ? state.settings.model : DEFAULT_MODEL();
      $('#fModel').value = m;
      onModelChange();
      $('#setModel').value = m; // 设置弹窗同样做旧模型兜底，避免静默不选中
      $('#setBaseUrl').value = state.settings.base_url;
      $('#setPollMs').value = state.settings.poll_interval_ms;
      $('#setMaxMin').value = state.settings.max_active_minutes;
      $('#setSubmitMs').value = state.settings.submit_interval_ms ?? 60000;
      // TTS（Fish Audio）
      $('#fishKeyStatus').textContent = state.settings.fish_api_key_set
        ? `（已保存 ${state.settings.fish_api_key_masked}，留空则不修改）`
        : '（未配置）';
      $('#setFishSpeed').value = state.settings.fish_speed ?? 1;
      const fv = await loadFishVoices();
      const curVoice = state.settings.fish_voice || 'default';
      $('#setFishVoice').innerHTML = (fv.voices || [])
        .map((v) => `<option value="${esc(v.id)}" ${v.id === curVoice ? 'selected' : ''}>${esc(v.title)}</option>`)
        .join('');
      // v1.4 BGM（音乐接口）
      $('#setMusicBase').value = state.settings.music_api_base || '';
      $('#musicTokenStatus').textContent = state.settings.music_api_token_set
        ? '（已保存，留空则不修改）'
        : '（未配置）';
      $('#setMusicLevel').value = state.settings.music_level || 'exhigh';
    } catch (e) {
      toast('加载设置失败：' + e.message, 'err');
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

  /* ---------------- 新建任务 ---------------- */
  const refState = { images: [], audios: [], videos: [] };

  function openNewTask(initial) {
    $('#newTaskModal').hidden = false;
    if (initial) applyTemplate(initial);
  }

  /** P1：新建任务类型切换（视频 ⇄ 图片），两套表单互斥 */
  function switchTaskType(ptype) {
    state.taskType = ptype === 'image' ? 'image' : 'video';
    $$('#taskTypeTabs .type-tab').forEach((t) => t.classList.toggle('active', t.dataset.ptype === state.taskType));
    $('#v25Form').hidden = state.taskType !== 'video';
    $('#imageForm').hidden = state.taskType !== 'image';
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
      if (state.taskType === 'image') {
        if (!$('#fiPrompt').value.trim()) throw new Error('请填写图片描述 prompt');
        t = await api('/api/images/tasks', { method: 'POST', body: collectImageBody() });
        toast(`图片任务 #${t.id} 已入队，生成完成后在列表中查看`, 'ok');
      } else {
        const body = collectBody();
        t = await api('/api/tasks', { method: 'POST', body });
        toast(`任务 #${t.id} 已提交（video_id: ${t.video_id || '-'}）`, 'ok');
      }
      $('#newTaskModal').hidden = true;
      if (state.taskType === 'image') resetImageForm();
      else resetNewTaskForm();
      await loadTasks();
    } catch (e) {
      toast('提交失败：' + e.message, 'err');
      await loadTasks(); // 失败也刷新列表，让 submit_error 任务立即显示
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
      body.videos = refState.videos.filter(Boolean);
    }
    return body;
  }

  function resetNewTaskForm() {
    $('#fPrompt').value = '';
    $('#fSeed').value = '';
    $('#fFirstFrame').value = '';
    $('#fLastFrame').value = '';
    $('#fTemplate').value = '';
    refState.images = [];
    refState.audios = [];
    refState.videos = [];
    renderRefList('images');
    renderRefList('audios');
    renderRefList('videos');
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

  function onModelChange() {
    const info = modelInfo($('#fModel').value);
    $('#modelHint').textContent = info ? `（${info.hint}）` : '';
    $('#fSize').innerHTML = (info?.sizes?.length ? info.sizes : ['720P'])
      .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
      .join('');
    const grpVideos = $('#grpVideos');
    if (grpVideos) grpVideos.classList.toggle('hidden', info ? !info.video_ref : false);
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
        promptEl.value = r.content;
        toast('已采用优化后的描述', 'ok');
      };
      if (window.__ui?.compare) {
        // 优化结果先对比，由用户决定采用；是否用 AI 优化始终由用户发起
        window.__ui.compare({
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

  /* ---------------- 设置 ---------------- */
  let fishVoicesCache = null;
  async function loadFishVoices() {
    if (!fishVoicesCache) {
      try {
        fishVoicesCache = await api('/api/tts/voices');
      } catch {
        fishVoicesCache = { voices: [] };
      }
    }
    return fishVoicesCache;
  }

  async function saveSettings() {
    const body = {
      base_url: $('#setBaseUrl').value.trim(),
      model: $('#setModel').value,
      poll_interval_ms: Number($('#setPollMs').value),
      max_active_minutes: Number($('#setMaxMin').value),
      submit_interval_ms: Number($('#setSubmitMs').value),
    };
    const key = $('#setApiKey').value.trim();
    if (key) body.api_key = key;
    const fishKey = $('#setFishKey').value.trim();
    if (fishKey) body.fish_api_key = fishKey;
    const fishVoice = $('#setFishVoice').value;
    if (fishVoice) body.fish_voice = fishVoice;
    const fishSpeed = Number($('#setFishSpeed').value);
    if (Number.isFinite(fishSpeed) && fishSpeed >= 0.5 && fishSpeed <= 2) body.fish_speed = fishSpeed;
    // v1.4 BGM（音乐接口）
    body.music_api_base = $('#setMusicBase').value.trim();
    const musicToken = $('#setMusicToken').value.trim();
    if (musicToken) body.music_api_token = musicToken;
    const musicLevel = $('#setMusicLevel').value;
    if (musicLevel) body.music_level = musicLevel;
    try {
      await api('/api/settings', { method: 'PUT', body });
      toast('设置已保存', 'ok');
      $('#settingsModal').hidden = true;
      $('#setApiKey').value = '';
      $('#setFishKey').value = '';
      $('#setMusicToken').value = '';
      await loadSettings();
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    }
  }

  /* ---------------- 日志 ---------------- */
  async function refreshLogs() {
    try {
      const { items } = await api('/api/logs');
      $('#logBox').textContent = items.map((l) => `[${fmtTime(l.ts)}] [${l.level}] ${l.msg}`).join('\n');
    } catch {
      /* ignore */
    }
  }

  /* ---------------- 弹窗通用 ---------------- */
  function bindModals() {
    $$('.modal-overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => {
        if (e.target === ov) ov.hidden = true; // 点遮罩关闭
      });
      ov.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) ov.hidden = true;
      });
    });
  }

  /* ---------------- 刷新循环 ---------------- */
  let loopBusy = false; // 防止上一轮请求未完成时堆叠（慢网络下旧响应覆盖新响应）
  let lastWsTasksRefresh = 0;
  function startLoop() {
    setInterval(async () => {
      if (document.hidden || loopBusy) return; // 后台标签页不刷新
      loopBusy = true;
      try {
        await loadTasks();
        if (state.detailId) await refreshDetail();
        if (!$('#logModal').hidden) await refreshLogs();
        // 工作台第④步任务进度低频自动更新（10s，独立于整页重绘，不打断编辑）
        if (!$('#workspaceView').hidden && Date.now() - lastWsTasksRefresh > 10000) {
          lastWsTasksRefresh = Date.now();
          window.__ws?.refreshTasks?.();
        }
      } catch {
        /* ignore */
      } finally {
        loopBusy = false;
      }
    }, 2000);
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
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

    // 提交与按钮
    $('#btnSubmitTask').addEventListener('click', submitTask);
    $('#btnNewTask').addEventListener('click', () => openNewTask(null));
    $('#btnSettings').addEventListener('click', () => {
      loadSettings();
      $('#settingsModal').hidden = false;
    });
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#btnLogs').addEventListener('click', () => {
      $('#logModal').hidden = false;
      refreshLogs();
    });

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
    bindModals();

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

    // 主视图切换：创作工作台 / 任务中心
    function switchView(v) {
      const ws = v === 'workspace';
      $('#navWorkspace').classList.toggle('active', ws);
      $('#navTasks').classList.toggle('active', !ws);
      $('#workspaceView').hidden = !ws;
      ['.stats', '.toolbar', '#emptyTip', '#btnNewTask'].forEach((sel) => {
        const el = $(sel);
        if (el) el.hidden = ws;
      });
      // P0：任务中心内部视图（列表/看板）恢复用户所选模式，避免两个容器同时显示
      $('#taskListView').hidden = ws || state.viewMode !== 'list';
      $('#board').hidden = ws || state.viewMode !== 'board';
      if (ws) window.__ws?.refresh?.();
    }
    $('#navWorkspace').addEventListener('click', () => switchView('workspace'));
    $('#navTasks').addEventListener('click', () => switchView('tasks'));

    // 初始加载
    window.__app = { applyTemplate, loadTasks, getSettings: () => state.settings };
    await loadMeta();
    await loadSettings();
    await loadTasks();
    startLoop();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
