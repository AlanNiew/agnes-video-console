/* Agnes Video 任务控制台 —— 前端逻辑（原生 JS，无依赖） */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATUS_LABEL = {
    queued: '队列中',
    in_progress: '生成中',
    completed: '已完成',
    failed: '失败',
    submit_error: '提交失败',
  };
  const MODE_LABEL = { text: '文生', keyframe: '首尾帧', reference: '参考', image: '图生', keyframes: '关键帧' };
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
  const DEFAULT_MODEL = () => (selectableModels().find((m) => m.free) || selectableModels()[0])?.id || 'agnes-video-2.5-flash';

  const state = {
    tasks: [],
    stats: null,
    settings: null,
    search: '',
    statusFilter: '',
    lastColSig: {}, // 列签名，避免无谓重建（防止视频播放被打断）
    detailSig: null,
  };

  /* ---------------- 工具 ---------------- */
  function fmtTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function relTime(ts) {
    if (!ts) return '-';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 10) return '刚刚';
    if (s < 60) return `${s}秒前`;
    if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
    return `${Math.floor(s / 86400)}天前`;
  }

  function toast(msg, type = '') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
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
    const isFlash = t.model.includes('flash');
    const metas = [
      MODE_LABEL[t.mode] || t.mode,
      t.seconds ? `${t.seconds}s` : null,
      t.aspect_ratio,
      t.size,
      modelShort(t.model),
      t.seed !== null && t.seed !== undefined ? `seed ${t.seed}` : null,
      t.video_id ? t.video_id.slice(-10) : null,
    ].filter(Boolean);
    const metaHtml = metas.map((m) => `<span class="meta-tag">${esc(m)}</span>`).join('');
    const mediaN = (t.images?.length || 0) + (t.audios?.length || 0) + (t.videos?.length || 0);

    let extra = '';
    if (t.status === 'in_progress') {
      extra = `<div class="pbar"><div style="width:${Math.max(2, Number(t.progress) || 0)}%"></div></div>`;
    }
    const playSrc = t.video_local_url || t.metadata_url; // v1.3：本地归档优先（远端链接会过期）
    if (t.status === 'completed' && playSrc) {
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
      actions.push(`<a class="act green" href="${esc(playSrc)}" target="_blank" rel="noopener">下载${t.video_local_url ? '' : ''}</a>`);
    }
    if (t.status === 'failed' || t.status === 'submit_error') {
      actions.push(`<button class="act" data-act="retry">重试</button>`);
    }
    actions.push(`<button class="act red" data-act="del">删除</button>`);

    return `
      <article class="card status-${t.status}" data-id="${t.id}">
        <div class="card-top">
          <span class="badge">${esc(MODE_LABEL[t.mode] || t.mode)}</span>
          <span class="badge">${esc(t.size || '-')}</span>
          <span class="card-id">#${t.id}</span>
          ${t.superseded ? '<span class="badge" style="opacity:.65" title="该镜头已有更新成功的任务，此失败记录仅供参考">已作废</span>' : ''}
          ${mediaN ? `<span class="badge" title="参考素材数">素材×${mediaN}</span>` : ''}
          <span class="card-time" title="${fmtTime(t.created_at)}">${relTime(t.created_at)}</span>
        </div>
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
            : [t.id, t.status, t.progress, t.video_id, t.error_message]
        )
      );
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
      el.innerHTML = byCol[col].length ? byCol[col].map(cardHTML).join('') : '<div class="muted" style="text-align:center;padding:18px 0;font-size:12px">暂无任务</div>';
    }
    $('#board').classList.toggle('focus', Boolean(filter));
    // 空态文案：区分「全局无任务」与「搜索/筛选无结果」
    const emptyEl = $('#emptyTip');
    emptyEl.hidden = state.tasks.length > 0;
    if (!emptyEl.hidden) {
      emptyEl.querySelector('h3').textContent = state.search
        ? `没有匹配「${state.search}」的任务`
        : state.statusFilter
          ? `暂无${STATUS_LABEL[state.statusFilter] || '该状态'}任务`
          : '还没有任务';
    }
    observeVideos();
  }

  /* ---------------- 视频懒加载（IntersectionObserver） ---------------- */
  let videoObserver = null;
  function observeVideos() {
    const videos = document.querySelectorAll('#board video[data-src]');
    if (!videos.length) return;
    if ('IntersectionObserver' in window) {
      if (!videoObserver) {
        videoObserver = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const v = en.target;
            if (!v.src) {
              v.src = v.dataset.src;
              // 元数据加载成功后，用真实时长替换角标（如 5.04s → 5s）
              v.addEventListener('loadedmetadata', () => {
                const dur = v.closest('.video-preview')?.querySelector('.vp-dur');
                if (dur && Number.isFinite(v.duration) && v.duration > 0) dur.textContent = `${Math.round(v.duration)}s`;
              }, { once: true });
            }
            videoObserver.unobserve(v);
          }
        }, { rootMargin: '180px' });
      }
      videos.forEach((v) => { if (!v.src) videoObserver.observe(v); });
    } else {
      // 不支持 IntersectionObserver 的浏览器：直接加载
      videos.forEach((v) => { if (!v.src) v.src = v.dataset.src; });
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
      const params = new URLSearchParams({ limit: '200' });
      if (state.statusFilter) params.set('status', state.statusFilter);
      if (state.search) params.set('q', state.search);
      const data = await api(`/api/tasks?${params}`);
      state.tasks = data.items;
      renderStats(data.stats);
      renderBoard();
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
    // 新建任务表单下拉
    $('#fModel').innerHTML = selectableModels()
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    $('#fSeconds').innerHTML = META.seconds
      .map((s) => `<option value="${esc(s)}" ${s === '5' ? 'selected' : ''}>${esc(s)}</option>`).join('');
    $('#fAspect').innerHTML = META.aspect_ratios
      .map((a) => `<option value="${esc(a)}" ${a === '16:9' ? 'selected' : ''}>${esc(a)}</option>`).join('');
    // 设置弹窗默认模型下拉（同样只列未下架模型）
    $('#setModel').innerHTML = selectableModels()
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  }

  async function loadSettings() {
    try {
      state.settings = await api('/api/settings');
      renderConn(true);
      $('#keyStatus').textContent = state.settings.api_key_set
        ? `（已保存 ${state.settings.api_key_masked}，留空则不修改）`
        : '（未配置）';
      // 旧模型兜底：设置里的默认模型若已下架，则回退默认免费模型
      const m = selectableModels().some((x) => x.id === state.settings.model)
        ? state.settings.model : DEFAULT_MODEL();
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

  function bindCardEvents() {
    $('#board').addEventListener('click', async (ev) => {
      const vp = ev.target.closest('.video-preview');
      const btn = ev.target.closest('[data-act]');
      if (!btn) {
        // 点击视频预览（或卡片其余区域仅当点击预览）→ 打开详情播放
        if (vp) {
          const card = vp.closest('.card');
          if (card) openDetail(Number(card.dataset.id));
        }
        return;
      }
      const card = ev.target.closest('.card');
      if (!card) return;
      const id = Number(card.dataset.id);
      const actName = btn.dataset.act;
      if (actName === 'detail') return openDetail(id);
      if (actName === 'poll') return act(id, '查询', async () => (await api(`/api/tasks/${id}/poll`, { method: 'POST' })).status);
      if (actName === 'retry') {
        if (confirm(`确认以原参数重新提交任务 #${id}？将创建一条新任务记录。`)) {
          await act(id, '重试', async () => {
            const r = await api(`/api/tasks/${id}/retry`, { method: 'POST' });
            return `新任务 #${r.task.id}`;
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

      const playSrc = t.video_local_url || t.metadata_url; // v1.3：本地归档优先
      let play = '';
      if (t.status === 'completed' && playSrc) {
        play = `<div class="detail-body-play"><video controls preload="metadata" src="${esc(playSrc)}"></video></div>`;
      }

      const req = t.request_json || {};
      const mediaRows = [];
      ['images', 'audios', 'videos'].forEach((k) => {
        const arr = t[k] || [];
        arr.forEach((v, i) => {
          const label = { images: 'Picture', audios: 'Audio', videos: 'Video' }[k];
          const url = typeof v === 'string' ? v : v?.url;
          mediaRows.push(dlRow(`<${label} ${i + 1}>`, url, 'url'));
        });
      });

      body.innerHTML = `
        <div class="detail-section">
          <div class="progress-big">
            <b>${t.status === 'in_progress' ? `${Number(t.progress) || 0}%` : esc(STATUS_LABEL[t.status] || t.status)}</b>
            ${t.status === 'in_progress' ? `<div class="pbar"><div style="width:${Math.max(2, Number(t.progress) || 0)}%"></div></div>` : ''}
          </div>
          ${play}
          <div class="detail-dl">
            ${dlRow('ID', '#' + t.id)}
            ${dlRow('状态', STATUS_LABEL[t.status] || t.status)}
            ${dlRow('模式', (MODE_LABEL[t.mode] || t.mode) + '（' + t.mode + '）')}
            ${dlRow('模型', t.model)}
            ${dlRow('提示词', t.prompt)}
            ${dlRow('时长', t.seconds + 's')}
            ${dlRow('画幅', t.aspect_ratio)}
            ${dlRow('分辨率', t.size)}
            ${t.num_frames !== null ? dlRow('帧数 num_frames', t.num_frames) : ''}
            ${t.frame_rate !== null ? dlRow('帧率 frame_rate', t.frame_rate) : ''}
            ${t.image ? dlRow('图生图片 image', t.image, 'url') : ''}
            ${t.negative_prompt ? dlRow('反向提示词 negative_prompt', t.negative_prompt) : ''}
            ${dlRow('seed', t.seed === null ? '' : t.seed)}
            ${dlRow('task_id', t.task_id)}
            ${dlRow('video_id', t.video_id)}
            ${dlRow('创建时间', fmtTime(t.created_at) + '（' + relTime(t.created_at) + '）')}
            ${dlRow('完成时间', fmtTime(t.completed_at))}
            ${dlRow('轮询次数', t.poll_count + ' 次' + (t.last_polled_at ? `（最后 ${relTime(t.last_polled_at)}）` : ''))}
            ${t.video_local_url ? dlRow('本地归档', t.video_local_url, 'url') : ''}
            ${dlRow('视频地址', t.metadata_url, 'url')}
            ${t.error_message ? dlRow('错误信息', t.error_message) : ''}
            ${mediaRows.join('')}
          </div>
        </div>
        <div class="detail-section"><h4>提交请求（request_json）</h4>${jsonBox(req)}</div>
        <div class="detail-section"><h4>最近一次查询响应</h4>${jsonBox(t.last_poll_response)}</div>
        ${t.submit_response ? `<div class="detail-section"><h4>创建任务响应</h4>${jsonBox(t.submit_response)}</div>` : ''}
      `;
      body.dataset.rendered = '1';
    }

    // 操作栏：仅按钮集合变化时重建，避免每 2s 替换节点吃掉点击
    const acts = [];
    if (t.video_id) acts.push(`<button class="btn ghost" id="dPoll">立即查询</button>`);
    if (t.status === 'failed' || t.status === 'submit_error') acts.push(`<button class="btn primary" id="dRetry">重试（新建任务）</button>`);
    if (t.status === 'completed' && (t.video_local_url || t.metadata_url)) {
      const dl = t.video_local_url || t.metadata_url;
      acts.push(`<a class="btn primary" href="${esc(dl)}" target="_blank" rel="noopener">下载视频</a>`);
    }
    acts.push(`<button class="btn ghost danger" id="dDel">删除任务</button>`);
    const actsSig = acts.join('|');
    if ($('#detailActions').dataset.sig !== actsSig) {
      $('#detailActions').dataset.sig = actsSig;
      $('#detailActions').innerHTML = acts.join('') + `<button class="btn ghost" data-close>关闭</button>`;

      $('#dStatus').textContent = STATUS_LABEL[t.status] || t.status;
      $('#dStatus').className = `chip-mini ${t.status}`;

      const bind = (idBtn, fn) => { const el = $('#' + idBtn); if (el) el.onclick = fn; };
      bind('dPoll', async () => { try { const r = await api(`/api/tasks/${id}/poll`, { method: 'POST' }); toast(`查询完成：${STATUS_LABEL[r.status] || r.status}`, 'ok'); await refreshDetail(); await loadTasks(); } catch (e) { toast(e.message, 'err'); } });
      bind('dRetry', async () => {
        if (!confirm(`确认以原参数重新提交任务 #${id}？将创建一条新任务记录。`)) return;
        try { const r = await api(`/api/tasks/${id}/retry`, { method: 'POST' }); toast(`已创建新任务 #${r.task.id}`, 'ok'); closeDetail(); await loadTasks(); } catch (e) { toast(e.message, 'err'); }
      });
      bind('dDel', async () => {
        if (!confirm(`确认删除任务 #${id}？`)) return;
        try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); toast('已删除', 'ok'); closeDetail(); await loadTasks(); } catch (e) { toast(e.message, 'err'); }
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

  function switchMode(mode) {
    $$('#modeTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    $('#grpKeyframe').classList.toggle('hidden', mode !== 'keyframe');
    $('#grpReference').classList.toggle('hidden', mode !== 'reference');
    const hint = $('#mediaHint');
    if (mode === 'text') hint.textContent = '纯文本模式：不携带任何媒体素材。';
    if (mode === 'keyframe') hint.textContent = '首帧/尾帧控制：至少提供一个图片 URL，生成结果会尽量保持为成片的真实首/尾帧。';
    if (mode === 'reference') hint.textContent = '多模态参考：素材作为内容/风格/节奏参考，提示词中用 <Picture 1>、<Audio 1>、<Video 1> 指代（从 1 编号）。';
  }

  function renderRefList(key) {
    const el = $('#ref' + key.charAt(0).toUpperCase() + key.slice(1));
    el.innerHTML = refState[key]
      .map((v, i) => {
        const extra = key === 'videos' && typeof v === 'object'
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
        refState.videos[i] = start !== undefined && start !== ''
          ? { url, start_seconds: Number(start) || 0, require_audio: false }
          : url;
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
      const body = collectBody();
      const t = await api('/api/tasks', { method: 'POST', body });
      toast(`任务 #${t.id} 已提交（video_id: ${t.video_id || '-'}）`, 'ok');
      $('#newTaskModal').hidden = true;
      resetNewTaskForm();
      await loadTasks();
    } catch (e) {
      toast('提交失败：' + e.message, 'err');
      await loadTasks(); // 失败也刷新看板，让 submit_error 任务立即显示在“失败”列
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
    refState.images = []; refState.audios = []; refState.videos = [];
    renderRefList('images'); renderRefList('audios'); renderRefList('videos');
  }

  /* ---------------- 模板 ---------------- */
  const TEMPLATES = {
    'text-city': { model: 'agnes-video-2.5-flash', mode: 'text', prompt: '雨后的未来城市街道，霓虹灯倒映在地面，一辆银色跑车缓慢驶过，电影级运镜，自然环境声' },
    'text-cats': { model: 'agnes-video-2.5-flash', mode: 'text', prompt: '夜晚森林中三只猫组成微型铜管乐队向前行进，镜头平稳后退，月光穿过树叶，自然脚步声与乐器声' },
    'text-ocean': { model: 'agnes-video-2.5-flash', mode: 'text', prompt: '航拍镜头缓缓掠过翡翠色海面，白色浪花在礁石上翻卷，阳光透过云层洒下，海鸥鸣叫，写实风格' },
    'keyframe-walk': { model: 'agnes-video-2.5-flash', mode: 'keyframe', prompt: '人物从首帧姿态自然转身走向窗边，衣物和头发运动真实，镜头缓慢推进，平滑过渡到尾帧构图' },
    'ref-character': { model: 'agnes-video-2.5-flash', mode: 'reference', prompt: '以 <Picture 1> 中的角色和美术风格为参考，角色在花田中自然奔跑，保持外观一致，低机位跟拍' },
    'ref-audio': { model: 'agnes-video-2.5-flash', mode: 'reference', prompt: '以 <Picture 1> 为视觉主体，根据 <Audio 1> 的节奏设计动作和镜头切换，保持自然连贯' },
    'ref-video': { model: 'agnes-video-2.5', mode: 'reference', prompt: '参考 <Video 1> 的主体动作和镜头节奏，将场景改为月光下的卧室，同时保持时序连贯' },
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
      .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const grpVideos = $('#grpVideos');
    if (grpVideos) grpVideos.classList.toggle('hidden', info ? !info.video_ref : false);
  }

  /* ---------------- 设置 ---------------- */
  let fishVoicesCache = null;
  async function loadFishVoices() {
    if (!fishVoicesCache) {
      try { fishVoicesCache = await api('/api/tts/voices'); } catch { fishVoicesCache = { voices: [] }; }
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
    try {
      await api('/api/settings', { method: 'PUT', body });
      toast('设置已保存', 'ok');
      $('#settingsModal').hidden = true;
      $('#setApiKey').value = '';
      $('#setFishKey').value = '';
      await loadSettings();
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    }
  }

  /* ---------------- 日志 ---------------- */
  async function refreshLogs() {
    try {
      const { items } = await api('/api/logs');
      $('#logBox').textContent = items
        .map((l) => `[${fmtTime(l.ts)}] [${l.level}] ${l.msg}`)
        .join('\n');
    } catch { /* ignore */ }
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
      } catch { /* ignore */ } finally {
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

    // ✨ AI 优化提示词（调文本模型）
    $('#btnAiOptimize').addEventListener('click', async () => {
      const idea = $('#fPrompt').value.trim();
      if (!idea) { toast('请先填写原始描述', 'err'); return; }
      const btn = $('#btnAiOptimize');
      btn.disabled = true;
      btn.textContent = '优化中…';
      try {
        const r = await api('/api/llm/chat', {
          method: 'POST',
          body: {
            system: '你是视频生成提示词优化器。把用户零散的想法改写为一条可直接用于 AI 视频生成的专业提示词，150~220 字，六段式按序书写：主体与场景（外观与空间具体化）→ 动作与变化（2~3 个有先后顺序的连续动作）→ 镜头语言（景别 + 运镜 + 转场）→ 光线与色调（时段、光源方向、色温）→ 视觉风格与画质 → 声音与节奏。规则：把抽象词替换为可视细节；不得增加用户未提及的新主体；保留用户原意与全部关键元素；只输出优化后的提示词本身，不要任何解释、前缀或引号。',
            messages: [{ role: 'user', content: idea }],
            temperature: 0.8,
          },
        });
        const adopt = () => {
          $('#fPrompt').value = r.content;
          toast('已采用优化后的提示词', 'ok');
        };
        if (window.__ui?.compare) {
          // 优化结果先对比，由用户决定采用；是否用 AI 优化始终由用户发起
          window.__ui.compare({
            title: '提示词优化对比',
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
        btn.textContent = '✨ AI 优化提示词';
      }
    });

    // 提交与按钮
    $('#btnSubmitTask').addEventListener('click', submitTask);
    $('#btnNewTask').addEventListener('click', () => openNewTask(null));
    $('#btnSettings').addEventListener('click', () => { loadSettings(); $('#settingsModal').hidden = false; });
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#btnLogs').addEventListener('click', () => { $('#logModal').hidden = false; refreshLogs(); });

    $('#btnClearDone').addEventListener('click', async () => {
      if (!confirm('确认删除全部已完成任务？')) return;
      try {
        const r = await api('/api/tasks/bulk/clear-completed', { method: 'POST' });
        toast(`已清理 ${r.removed} 条`, 'ok');
        if (state.detailId) refreshDetail(); // 被清空的任务若是当前打开的详情，触发 404 自动关闭
        loadTasks();
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#btnClearFailed').addEventListener('click', async () => {
      if (!confirm('确认删除全部失败/提交失败任务？')) return;
      try {
        const r = await api('/api/tasks/bulk/clear-failed', { method: 'POST' });
        toast(`已清理 ${r.removed} 条`, 'ok');
        if (state.detailId) refreshDetail();
        loadTasks();
      } catch (e) { toast(e.message, 'err'); }
    });

    // 搜索 + 状态过滤
    let searchTimer = null;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = e.target.value.trim(); loadTasks(); }, 350);
    });
    $('#statusChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $$('#statusChips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.statusFilter = chip.dataset.status;
      loadTasks();
    });

    bindCardEvents();
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
      ['.stats', '.toolbar', '#board', '#emptyTip', '#btnNewTask'].forEach((sel) => {
        const el = $(sel);
        if (el) el.hidden = ws;
      });
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