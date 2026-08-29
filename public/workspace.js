/* 创作工作台 —— 流水线 UI（创意 → 文案 → 角色设定 → 视频） */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const STATUS_LABEL = { queued: '队列中', in_progress: '生成中', completed: '已完成', failed: '失败', submit_error: '提交失败' };
  const KIND_LABEL = {
    script: '故事梗概',
    video_prompt: '视频提示词',
    character_desc: '角色外观描述',
    scene_desc: '场景描述',
  };

  let currentProjectId = null;
  let imgGenBusy = false;
  let scriptBusy = false;
  let storyBusy = false;      // M2：分镜生成中
  let currentShotCount = 0;   // M2：当前项目镜头数（供重生成确认判断）
  let batchBusy = false;      // M2：批量提交进行中
  let batchStop = false;      // M2：批量提交停止标记
  let batchHint = '';         // M2：批量提交进度提示

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let META = null; // 模型/画幅/时长元数据（GET /api/meta，与任务中心同源）
  async function getMeta() {
    if (!META) META = await api('/api/meta');
    return META;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  function toast(msg, type = '') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  /* ---------------- 视图 ---------------- */
  async function refresh() {
    if ($('#workspaceView').hidden) return;
    try {
      if (currentProjectId) await renderProject(currentProjectId);
      else await renderList();
    } catch (e) {
      $('#workspaceView').innerHTML = `<div class="ws-pad"><div class="ws-loading">加载失败：${esc(e.message)}</div></div>`;
    }
  }

  async function renderList() {
    const { items } = await api('/api/projects');
    const ws = $('#workspaceView');
    ws.innerHTML = `
      <div class="ws-pad">
        <div class="ws-head">
          <h2>🎬 创作工作台</h2>
          <span class="muted">创意 → 文案 → 角色设定 → 视频（模型自动选用最新免费版）</span>
          <span class="spacer"></span>
          <button class="btn primary" id="wsNewProject">＋ 新建项目</button>
        </div>
        ${items.length
          ? `<div class="ws-grid">${items.map(cardHTML).join('')}</div>`
          : `<div class="empty-box" style="margin:40px auto;max-width:480px"><h3>还没有创作项目</h3><p>一句话想法 → AI 出文案 → 生成角色设定图 → 一键发起视频任务，全部免费。</p></div>`}
      </div>`;
    $('#wsNewProject').onclick = () => openNewProject().catch((e) => toast('打开新建项目失败：' + e.message, 'err'));
    ws.querySelectorAll('.ws-card').forEach((c) =>
      c.addEventListener('click', () => { currentProjectId = Number(c.dataset.id); renderProject(currentProjectId); })
    );
  }

  function cardHTML(p) {
    return `
      <div class="ws-card" data-id="${p.id}">
        <h3>${esc(p.name)}</h3>
        <div class="idea">${esc(p.idea || '（无简介）')}</div>
        <div class="meta">
          ${p.style ? `<span class="meta-tag">风格：${esc(p.style)}</span>` : ''}
          <span class="meta-tag">${esc(p.aspect_ratio || '16:9')}</span>
          <span class="meta-tag">${esc(p.seconds || '5')}s</span>
        </div>
        <div class="foot">更新于 ${fmtTime(p.updated_at)}</div>
      </div>`;
  }

  async function openNewProject() {
    const meta = await getMeta();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head"><h2>新建创作项目</h2><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>项目名称 *</label><input type="text" id="npName" placeholder="如：夏日麦田少年" /></div>
          <div class="field"><label>一句话创意 *</label><textarea id="npIdea" rows="3" placeholder="例：黄昏麦田，穿黄胶鞋的少年沿着土路走向远方，暖金色逆光"></textarea></div>
          <div class="field"><label>风格偏好（可选）</label><input type="text" id="npStyle" placeholder="如：电影写实 / 国风水墨 / 赛博朋克" /></div>
          <div class="grid2">
            <div class="field"><label>画幅</label>
              <select id="npAspect">${meta.aspect_ratios.map((a) => `<option value="${esc(a)}" ${a === '16:9' ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
            </div>
            <div class="field"><label>目标时长</label>
              <select id="npSeconds">${meta.seconds.map((s) => `<option value="${esc(s)}" ${s === '5' ? 'selected' : ''}>${esc(s)} 秒</option>`).join('')}</select>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost">取消</button>
          <button class="btn primary" id="npCreate">创建并生成文案</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]') || e.target.classList.contains('modal-close') || e.target.closest('.btn.ghost')) close(); });
    $('#npCreate', overlay).onclick = async () => {
      const name = $('#npName', overlay).value.trim();
      const idea = $('#npIdea', overlay).value.trim();
      if (!name || !idea) { toast('请填写项目名称与创意', 'err'); return; }
      const btn = $('#npCreate', overlay);
      btn.disabled = true; btn.textContent = '创建中…';
      try {
        const p = await api('/api/projects', {
          method: 'POST',
          body: { name, idea, style: $('#npStyle', overlay).value.trim(), aspect_ratio: $('#npAspect', overlay).value, seconds: $('#npSeconds', overlay).value },
        });
        close();
        currentProjectId = p.id;
        await renderProject(p.id);
        toast('项目已创建，正在生成文案…', 'ok');
        genScript(p.id); // 后台生成文案
      } catch (e) {
        toast('创建失败：' + e.message, 'err');
        btn.disabled = false; btn.textContent = '创建并生成文案';
      }
    };
  }

  /* 步骤④的模型标签：与流水线实际使用的免费视频模型保持同源 */
  function videoModelTag(meta) {
    const m = meta.models.find((x) => x.id === 'agnes-video-2.5-flash')
      || meta.models.find((x) => !x.deprecated && x.free)
      || meta.models[0];
    return `${m.short}（${m.free ? '免费' : '付费'} · ${(m.sizes || ['-'])[0] || '-'}）`;
  }

  /* ---------------- 项目详情 ---------------- */
  async function renderProject(id) {
    const [d, meta] = await Promise.all([api(`/api/projects/${id}`), getMeta()]);
    const p = d.project;
    const texts = d.texts || [];
    const images = d.images || [];
    const tasks = d.tasks || [];
    const shots = d.shots || [];
    currentShotCount = shots.length;
    const selVideo = (t) => t.find((x) => x.kind === 'video_prompt' && x.selected) || t.find((x) => x.kind === 'video_prompt');
    const selChar = images.find((x) => x.kind === 'character' && x.selected) || images.find((x) => x.kind === 'character');
    const selVideoText = selVideo(texts);
    const stepsDone = {
      1: Boolean(p.idea),
      2: texts.some((t) => t.kind === 'video_prompt' || t.kind === 'storyboard') || shots.length > 0,
      3: Boolean(selChar),
      4: tasks.length > 0, // M2 起 projects.status 退役，纯聚合推导
    };
    const stepState = (n) => (stepsDone[n] ? 'done' : '');

    const ws = $('#workspaceView');
    ws.innerHTML = `
      <div class="ws-pad">
        <div class="ws-head">
          <button class="btn ghost" id="wsBack">← 项目列表</button>
          <h2>${esc(p.name)}</h2>
          ${p.idea ? `<span class="muted">${esc(p.idea)}</span>` : ''}
          <span class="spacer"></span>
          <button class="btn ghost danger" id="wsDel" title="删除项目（关联的视频任务保留）">删除</button>
        </div>
        <div class="steps">
          <div class="step ${stepState(1)} active"><span class="n">①</span>创意</div>
          <div class="step ${stepState(2)}"><span class="n">②</span>文案与提示词</div>
          <div class="step ${stepState(3)}"><span class="n">③</span>角色设定图</div>
          <div class="step ${stepState(4)}"><span class="n">④</span>视频生成</div>
        </div>

        <!-- ② 文案与分镜 -->
        <div class="copy-sect">
          <h4>📝 文案与提示词 <span class="badge-selected" hidden id="wsCopyDone">已生成</span></h4>
          ${scriptBusy ? '<div class="ws-loading"><span class="spinner"></span> 文本模型正在创作文案…</div>' : `
          <button class="btn primary sm" id="wsGenScript">✨ 生成 / 重新生成文案</button>
          <div class="hint mt">梗概、角色描述、场景描述一次生成；分镜在下方独立生成与编辑。</div>`}
          <div id="wsCopySections" class="mt">
            ${storyBusy ? '<div class="ws-loading"><span class="spinner"></span> 文本模型正在生成分镜…</div>' : renderStoryboardArea(texts, shots, p, meta)}
            ${renderTextSections(texts, ['script', 'character_desc', 'scene_desc'])}
          </div>
        </div>

        <!-- ③ 角色设定 -->
        <div class="copy-sect">
          <h4>🧑‍🎨 角色设定图 <span class="muted" style="font-weight:400">（参考图用于视频，减少角色幻觉）</span></h4>
          <div class="grid2">
            <div class="field"><label>角色外观描述（可手动调整）</label>
              <textarea id="wsCharDesc" rows="3">${esc((texts.find((t) => t.kind === 'character_desc' && t.selected) || texts.find((t) => t.kind === 'character_desc') || {}).content || p.idea || '')}</textarea>
            </div>
            <div class="field">
              <label>画幅 / 分辨率档位</label>
              <div class="grid2">
                <select id="wsImgRatio">${meta.image.ratios.map((a) => `<option value="${esc(a)}" ${a === '1:1' ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
                <select id="wsImgSize">${meta.image.sizes.map((s) => `<option value="${esc(s)}" ${s === '1K' ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
              </div>
              ${imgGenBusy ? '<div class="ws-loading mt"><span class="spinner"></span> 图片生成中（约 10–60 秒）…</div>' : '<button class="btn primary sm mt" id="wsGenChar">🎨 生成角色图</button>'}
              <div class="hint mt">点击图片定稿（绿色边框）；不满意可再生成。</div>
            </div>
          </div>
          <div class="img-wall mt" id="wsCharWall">${images.filter((x) => x.kind === 'character').map(imgCell).join('')}</div>
        </div>

        <!-- ④ 视频 -->
        <div class="copy-sect">
          <h4>🎬 发起视频任务</h4>
          <div class="video-assemble">
            <div class="ref-row">
              <div class="ref-img">${selChar ? `<img src="${esc(selChar.local_url || selChar.remote_url)}" alt="角色定稿图" />` : '<div class="muted" style="padding:30px 8px;text-align:center">未定稿</div>'}</div>
              <div class="ref-txt">
                ${shots.length
                  ? `<b>角色定稿图：</b>${selChar ? '已就绪，所有镜头将引用该图（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」）' : '未定稿——请先在上方完成角色图定稿'}`
                  : `<b>分镜提示词：</b>${esc(selVideoText?.content || '（请先完成文案步骤）')}`}
              </div>
            </div>
            ${shots.length ? renderShotSubmitBlock(shots, tasks, selChar) : `
            <div class="row mt" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <select id="wsVSeconds" class="meta-tag" title="视频时长" style="background:var(--bg)">
                ${meta.seconds.map((s) => `<option value="${esc(s)}" ${s === String(p.seconds || 5) ? 'selected' : ''}>${esc(s)} 秒</option>`).join('')}
              </select>
              <select id="wsVAspect" class="meta-tag" style="background:var(--bg)">
                ${meta.aspect_ratios.map((a) => `<option ${a === (p.aspect_ratio || '16:9') ? 'selected' : ''}>${esc(a)}</option>`).join('')}
              </select>
              <span class="meta-tag">${esc(videoModelTag(meta))}</span>
              <span class="spacer" style="flex:1"></span>
              <button class="btn primary" id="wsSubmitVideo" ${selChar && selVideoText ? '' : 'disabled'}>🚀 提交视频任务</button>
            </div>
            <div class="hint mt">将用：定稿角色图 + 分镜提示词（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」）</div>`}
          </div>
          ${`<div id="wsTaskList">${renderTaskList(tasks, shots)}</div>`}
        </div>
      </div>`;

    $('#wsBack').onclick = () => { currentProjectId = null; renderList(); };
    $('#wsDel').onclick = async () => {
      if (!confirm(`确认删除项目「${p.name}」？文案与角色图将一并删除，视频任务保留。`)) return;
      try {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        toast('项目已删除', 'ok');
        currentProjectId = null;
        await renderList();
      } catch (e) {
        toast('删除失败：' + e.message, 'err');
      }
    };
    // M2：有分镜时旧的单任务提交控件不渲染，全部做存在性守卫绑定
    const genScriptBtn = $('#wsGenScript');
    if (genScriptBtn && !scriptBusy) genScriptBtn.onclick = () => genScript(p.id);
    const genCharBtn = $('#wsGenChar');
    if (genCharBtn) genCharBtn.onclick = () => genCharacterImage(p.id);
    const submitVideoBtn = $('#wsSubmitVideo');
    if (submitVideoBtn) submitVideoBtn.onclick = () => submitVideo(p.id);
    bindTextSectionEvents(p.id);
    bindWallEvents(p.id);
    bindStoryboardEvents(p.id);
    // M2 第④步：镜头提交 / 批量提交 / 停止
    document.querySelectorAll('#wsShotSubmit [data-shot-submit]').forEach((b) => {
      b.onclick = () => submitShot(p.id, Number(b.dataset.shotSubmit));
    });
    const batchBtn = $('#wsBatchSubmit');
    if (batchBtn) batchBtn.onclick = () => runBatchSubmit(p.id);
    const stopBtn = $('#wsBatchStop');
    if (stopBtn) {
      stopBtn.onclick = () => {
        batchStop = true;
        toast('将在当前镜头提交完成后停止批量', 'warn');
      };
    }
    // 跳转任务中心
    bindGotoTaskLinks();
  }

  /* 任务列表局部刷新：只更新 #wsTaskList，不打断文案/描述编辑 */
  async function refreshTasks() {
    const box = $('#wsTaskList');
    if (!box || !currentProjectId) return;
    try {
      const d = await api(`/api/projects/${currentProjectId}`);
      box.innerHTML = renderTaskList(d.tasks || [], d.shots || []);
      bindGotoTaskLinks();
    } catch { /* 静默：下次轮询自愈 */ }
  }

  /* ---------------- M2：第④步镜头提交与批量 ---------------- */

  /** 镜头最新任务（tasks 按 created_at DESC 返回，首个即最新） */
  function shotLatestTask(tasks, shotId) {
    return tasks.find((t) => t.shot_id === shotId) || null;
  }

  function shotStatusBadge(t) {
    if (!t) return '<span class="meta-tag">未提交</span>';
    const label = STATUS_LABEL[t.status] || t.status;
    const pct = t.status === 'in_progress' ? ` ${Number(t.progress) || 0}%` : '';
    return `<span class="meta-tag">${esc(label)}${pct}</span>`;
  }

  function renderShotSubmitBlock(shots, tasks, selChar) {
    const pendingShots = shots.filter((s) => {
      const t = shotLatestTask(tasks, s.id);
      return !t || t.status === 'failed' || t.status === 'submit_error';
    });
    return `
      <div class="hint mt">以下镜头将引用定稿角色图（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」），每个镜头一条独立视频任务。</div>
      <div id="wsShotSubmit" class="mt">
        ${shots.map((s) => {
          const t = shotLatestTask(tasks, s.id);
          const active = t && (t.status === 'queued' || t.status === 'in_progress');
          return `
          <div class="ver-item shot-submit-row">
            <b>镜头 ${s.seq}</b>${s.title ? ` · ${esc(s.title)}` : ''}
            <span class="meta-tag">${esc(String(s.seconds || '5'))}s</span>
            ${shotStatusBadge(t)}
            <span class="spacer" style="flex:1"></span>
            <button class="btn primary sm" data-shot-submit="${s.id}" ${selChar && !active && !batchBusy ? '' : 'disabled'}>🚀 提交</button>
          </div>`;
        }).join('')}
      </div>
      <div class="row mt" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn primary" id="wsBatchSubmit" ${batchBusy || !selChar ? 'disabled' : ''}>
          ${batchBusy ? '批量提交中…' : `🚀 批量提交未完成镜头（${pendingShots.length}/${shots.length}）`}
        </button>
        ${batchBusy ? '<button class="btn ghost sm" id="wsBatchStop">停止批量</button>' : ''}
        <span class="hint" id="wsBatchHint">${esc(batchHint)}</span>
      </div>
      <div class="hint mt">批量提交按设置中的「批量提交间隔」逐个发起；关闭页面即停止后续提交，已提交的不受影响。</div>`;
  }

  async function submitShot(projectId, shotId) {
    const btn = document.querySelector(`[data-shot-submit="${shotId}"]`);
    if (!btn || btn.disabled) return; // 防连点重复提交
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const r = await api(`/api/projects/${projectId}/shots/${shotId}/videos`, { method: 'POST', body: {} });
      toast(`镜头任务 #${r.id} 已提交`, 'ok');
      window.__app?.loadTasks?.();
      if (currentProjectId === projectId) await renderProject(projectId);
    } catch (e) {
      toast('提交失败：' + e.message, 'err');
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = '🚀 提交';
      }
    }
  }

  /** 批量提交「未完成」镜头（无任务或最新任务失败），按 submit_interval_ms 节流 */
  async function runBatchSubmit(projectId) {
    if (batchBusy) return;
    let targets;
    try {
      const d = await api(`/api/projects/${projectId}`);
      const shots = d.shots || [];
      targets = shots.filter((s) => {
        const t = shotLatestTask(d.tasks || [], s.id);
        return !t || t.status === 'failed' || t.status === 'submit_error';
      });
    } catch (e) { toast(e.message, 'err'); return; }
    if (!targets.length) { toast('所有镜头都已有进行中或已完成的任务', 'ok'); return; }
    const interval = Math.max(0, Number(window.__app?.getSettings?.()?.submit_interval_ms ?? 60000) || 0);
    if (!confirm(`将按间隔 ${Math.round(interval / 1000)} 秒依次提交 ${targets.length} 个镜头的视频任务，继续？`)) return;
    batchBusy = true;
    batchStop = false;
    batchHint = '准备提交…';
    await renderProject(projectId); // 切换为「批量提交中…」与停止按钮
    let done = 0;
    let fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const s = targets[i];
      if (batchStop) break;
      const hintEl = () => { const el = $('#wsBatchHint'); if (el) el.textContent = batchHint; };
      batchHint = `正在提交镜头 ${s.seq}（${i + 1}/${targets.length}）…`;
      hintEl();
      try {
        await api(`/api/projects/${projectId}/shots/${s.id}/videos`, { method: 'POST', body: {} });
        done += 1;
      } catch (e) {
        fail += 1;
        toast(`镜头 ${s.seq} 提交失败：${e.message}`, 'err');
      }
      // 倒计时等待（每秒检查停止标记）
      const last = i === targets.length - 1;
      if (interval > 0 && !last) {
        for (let w = Math.round(interval / 1000); w > 0 && !batchStop; w--) {
          batchHint = `镜头 ${s.seq} 已提交，${w}s 后提交下一个（${i + 1}/${targets.length}）…`;
          hintEl();
          await sleep(1000);
        }
      }
    }
    batchBusy = false;
    batchHint = `批量提交结束：成功 ${done}${fail ? `，失败 ${fail}` : ''}${batchStop ? '（已手动停止）' : ''}`;
    toast(batchHint, fail ? 'warn' : 'ok');
    window.__app?.loadTasks?.();
    if (currentProjectId === projectId) await renderProject(projectId);
  }

  /* ---------------- M2：分镜区（生成 / 编辑 / 排序 / 历史版本） ---------------- */

  function renderStoryboardArea(texts, shots, p, meta) {
    const sbVersions = texts.filter((t) => t.kind === 'storyboard');
    const secondsOpts = (sel) => meta.seconds
      .map((s) => `<option value="${esc(s)}" ${s === String(sel || p.seconds || 5) ? 'selected' : ''}>${esc(s)} 秒</option>`).join('');
    const countSelect = `<select id="wsShotCount" class="meta-tag" style="background:var(--bg)" title="镜头数量">
      <option value="auto">自动</option><option value="3">3 镜</option><option value="5">5 镜</option><option value="8">8 镜</option>
    </select>`;
    const hasLegacyPrompt = Boolean((texts.find((t) => t.kind === 'video_prompt' && t.selected) || texts.find((t) => t.kind === 'video_prompt') || {}).content);

    if (!shots.length) {
      // 尚无分镜：保留旧的单条「视频提示词」卡，提供生成/升级入口
      return `
        <div class="copy-sect" data-kind="video_prompt">
          <h4>🎬 分镜脚本 ${sbVersions.length ? `<span class="badge-ver">${sbVersions.length} 版</span>` : ''}</h4>
          <div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            ${countSelect}
            <button class="btn primary sm" id="wsGenStoryboard">✨ 生成分镜</button>
            <button class="btn ghost sm" id="wsPromoteShot" ${hasLegacyPrompt ? '' : 'disabled'} title="把下方当前视频提示词变成 1 个镜头">升级为分镜</button>
          </div>
          <div class="hint mt">生成分镜后，每个镜头可独立编辑、排序、单独提交视频。</div>
          ${renderTextSections(texts.filter((t) => t.kind === 'video_prompt'), ['video_prompt'])}
        </div>`;
    }

    return `
      <div class="copy-sect" data-kind="storyboard">
        <h4>🎬 分镜脚本 <span class="badge-ver">${shots.length} 镜</span>
          ${sbVersions.length ? `<span class="badge-ver">${sbVersions.length} 版</span>` : ''}
          ${sbVersions.some((t) => t.selected) ? '<span class="badge-selected">使用中</span>' : ''}
        </h4>
        <div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          ${countSelect}
          <button class="btn primary sm" id="wsGenStoryboard">✨ 重新生成分镜</button>
          <button class="btn ghost sm" id="wsAddShot">＋ 添加镜头</button>
          ${sbVersions.length > 1 ? `<details class="hint" style="display:inline-block"><summary>历史版本</summary><div class="ver-list mt">
            ${sbVersions.map((t) => `<div class="ver-item">#${t.id} · ${fmtTime(t.created_at)}${t.selected ? ' · <b>使用中</b>' : ''} ${t.selected ? '' : `<button class="btn ghost sm" data-apply-sb="${t.id}">选用</button>`}</div>`).join('')}
          </div></details>` : ''}
        </div>
        <div class="hint mt">每个镜头可独立编辑保存、排序、删除；提交视频在下方第 ④ 步。</div>
        <div id="wsShotList">
          ${shots.map((s, i) => `
          <div class="copy-sect shot-card" data-shot-id="${s.id}">
            <div class="shot-head">
              <span class="badge">镜头 ${s.seq}</span>
              <input class="shot-title" data-shot-title value="${esc(s.title || '')}" placeholder="镜头标题（可选）" />
              <button class="btn ghost sm" data-shot-up ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
              <button class="btn ghost sm" data-shot-down ${i === shots.length - 1 ? 'disabled' : ''} title="下移">↓</button>
              <button class="btn ghost sm danger" data-shot-del title="删除镜头">✕</button>
            </div>
            <textarea data-shot-prompt rows="3">${esc(s.video_prompt)}</textarea>
            <div class="row" style="display:flex;gap:10px;align-items:center;margin-top:6px">
              <select data-shot-seconds class="meta-tag" style="background:var(--bg)">${secondsOpts(s.seconds)}</select>
              <button class="btn ghost sm" data-shot-save>保存修改</button>
            </div>
          </div>`).join('')}
        </div>
      </div>`;
  }

  function bindStoryboardEvents(projectId) {
    const gen = $('#wsGenStoryboard');
    if (gen) gen.onclick = () => genStoryboard(projectId);
    const promote = $('#wsPromoteShot');
    if (promote) promote.onclick = () => promoteToStoryboard(projectId);
    const add = $('#wsAddShot');
    if (add) {
      add.onclick = async () => {
        try {
          await api(`/api/projects/${projectId}/shots`, {
            method: 'POST',
            body: { title: '新镜头', video_prompt: '（请填写本镜头的画面描述与镜头语言）' },
          });
          await renderProject(projectId);
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    document.querySelectorAll('#wsShotList [data-apply-sb]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('选用该历史分镜版本？当前镜头列表将被覆盖（可再次选用其他版本恢复）。')) return;
        try {
          await api(`/api/projects/${projectId}/storyboard/apply`, { method: 'POST', body: { text_id: Number(b.dataset.applySb) } });
          toast('已选用该分镜版本', 'ok');
          await renderProject(projectId);
        } catch (e) { toast(e.message, 'err'); }
      })
    );
    document.querySelectorAll('#wsShotList .shot-card').forEach((card) => {
      const id = Number(card.dataset.shotId);
      const save = card.querySelector('[data-shot-save]');
      if (save) {
        save.onclick = async () => {
          try {
            await api(`/api/projects/${projectId}/shots/${id}`, {
              method: 'PATCH',
              body: {
                title: card.querySelector('[data-shot-title]').value,
                video_prompt: card.querySelector('[data-shot-prompt]').value,
                seconds: card.querySelector('[data-shot-seconds]').value,
              },
            });
            toast('镜头已保存', 'ok');
            await renderProject(projectId);
          } catch (e) { toast(e.message, 'err'); }
        };
      }
      const del = card.querySelector('[data-shot-del]');
      if (del) {
        del.onclick = async () => {
          if (!confirm('删除该镜头？已提交的该镜头视频任务会保留在任务中心。')) return;
          try {
            await api(`/api/projects/${projectId}/shots/${id}`, { method: 'DELETE' });
            toast('镜头已删除', 'ok');
            await renderProject(projectId);
          } catch (e) { toast(e.message, 'err'); }
        };
      }
      const up = card.querySelector('[data-shot-up]');
      if (up) up.onclick = () => moveShot(projectId, card, -1);
      const down = card.querySelector('[data-shot-down]');
      if (down) down.onclick = () => moveShot(projectId, card, 1);
    });
  }

  async function moveShot(projectId, card, dir) {
    const list = [...document.querySelectorAll('#wsShotList .shot-card')].map((c) => Number(c.dataset.shotId));
    const idx = list.indexOf(Number(card.dataset.shotId));
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    try {
      await api(`/api/projects/${projectId}/shots/reorder`, { method: 'POST', body: { ids: list } });
      await renderProject(projectId);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function genStoryboard(projectId) {
    if (storyBusy) return; // 防重入
    if (currentShotCount > 0 && !confirm('重新生成分镜将覆盖当前镜头列表（历史版本保留，可选用恢复），继续？')) return;
    storyBusy = true;
    await renderProject(projectId);
    try {
      const { project } = await api(`/api/projects/${projectId}`);
      const r = await api('/api/llm/storyboard', {
        method: 'POST',
        body: {
          idea: project.idea,
          style: project.style,
          aspect_ratio: project.aspect_ratio,
          seconds: project.seconds,
          shot_count: $('#wsShotCount')?.value || 'auto',
          project_id: projectId,
        },
      });
      if (!r.parsed) toast('模型未按结构化输出分镜（原始输出已保存到脚本区供参考）', 'warn');
      else toast(`分镜已生成（${r.shots?.length ?? 0} 个镜头）`, 'ok');
    } catch (e) {
      toast('分镜生成失败：' + e.message, 'err');
    } finally {
      storyBusy = false;
      if (currentProjectId === projectId) await renderProject(projectId);
    }
  }

  async function promoteToStoryboard(projectId) {
    try {
      const d = await api(`/api/projects/${projectId}`);
      const sel = (d.texts || []).find((t) => t.kind === 'video_prompt' && t.selected) || (d.texts || []).find((t) => t.kind === 'video_prompt');
      const content = sel?.content?.trim();
      if (!content) { toast('没有可用的视频提示词，请先生成文案或手写', 'err'); return; }
      await api(`/api/projects/${projectId}/shots`, { method: 'POST', body: { title: '镜头 1', video_prompt: content } });
      toast('已把当前视频提示词升级为 1 个镜头', 'ok');
      await renderProject(projectId);
    } catch (e) { toast(e.message, 'err'); }
  }

  /* 项目任务列表（独立渲染，供局部刷新；M2 起按镜头分组） */
  function renderTaskList(tasks, shots = []) {
    if (!tasks.length) return '';
    const row = (t) => `
      <div class="ver-item">
        #${t.id} · ${esc(STATUS_LABEL[t.status] || t.status)} · ${Number(t.progress) > 0 ? `${Number(t.progress)}%` : ''} · ${fmtTime(t.created_at)}
        ${t.status === 'completed' && t.metadata_url ? `<a class="act green" href="${esc(t.metadata_url)}" target="_blank" rel="noopener">播放/下载</a>` : ''}
        <a class="act" href="#" data-goto-task="${t.id}" style="margin-left:auto">去任务中心查看</a>
      </div>`;
    const shotMap = new Map(shots.map((s) => [s.id, s]));
    const groups = [];   // 有镜头归属的任务
    const others = [];   // 无归属（旧流程/镜头已删）
    for (const t of tasks) {
      if (t.shot_id && shotMap.has(t.shot_id)) {
        let g = groups.find((x) => x.shotId === t.shot_id);
        if (!g) { g = { shotId: t.shot_id, items: [] }; groups.push(g); }
        g.items.push(t);
      } else {
        others.push(t);
      }
    }
    groups.sort((a, b) => (shotMap.get(a.shotId)?.seq || 0) - (shotMap.get(b.shotId)?.seq || 0));
    return `
      <div class="mt"><b>本项目视频任务：</b></div>
      <div class="ver-list mt">
        ${groups.map((g) => {
          const s = shotMap.get(g.shotId);
          return `<div class="mt"><span class="badge">镜头 ${s.seq}</span>${s.title ? ` <span class="muted">${esc(s.title)}</span>` : ''}</div>${g.items.map(row).join('')}`;
        }).join('')}
        ${others.length ? `<div class="mt"><span class="badge">其他</span></div>${others.map(row).join('')}` : ''}
      </div>`;
  }

  function bindGotoTaskLinks() {
    document.querySelectorAll('#wsTaskList [data-goto-task]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        $('#navTasks')?.click();
        const card = document.querySelector(`.card[data-id="${a.dataset.gotoTask}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
    );
  }

  /* 文案分区渲染（kinds 控制渲染哪几类；分镜区独立于本函数，见 renderStoryboardArea） */
  function renderTextSections(texts, kinds = ['script', 'character_desc', 'scene_desc']) {
    const byKind = {};
    for (const t of texts) (byKind[t.kind] = byKind[t.kind] || []).push(t);
    return kinds.map((kind) => {
      const list = byKind[kind] || [];
      const latest = list[0] || null;
      const sel = list.find((x) => x.selected) || latest;
      return `
        <div class="copy-sect" data-kind="${kind}">
          <h4>${KIND_LABEL[kind] || kind}
            ${list.length ? `<span class="badge-ver">${list.length} 版</span>` : ''}
            ${sel?.selected ? '<span class="badge-selected">使用中</span>' : ''}
          </h4>
          ${sel ? `<textarea data-text-id="${sel.id}" rows="3">${esc(sel.content)}</textarea>
            <div class="row">
              <button class="btn ghost sm" data-save-text="${sel.id}">保存修改</button>
              <button class="btn ghost sm" data-use-text="${sel.id}">选用此版本</button>
              ${list.length > 1 ? `<details class="hint" style="display:inline-block"><summary>历史版本</summary><div class="ver-list mt">
                ${list.slice(1).map((t) => `<div class="ver-item">#${t.id} · ${fmtTime(t.created_at)} · ${esc(t.content.slice(0, 40))}… <button class="btn ghost sm" data-use-text="${t.id}">选用</button></div>`).join('')}
              </div></details>` : ''}
            </div>` : '<div class="muted">（暂无内容，点上方「生成文案」）</div>'}
        </div>`;
    }).join('');
  }

  function bindTextSectionEvents(projectId) {
    document.querySelectorAll('#wsCopySections [data-save-text]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ta = b.closest('.copy-sect').querySelector('textarea');
        if (!ta) return;
        try {
          await api(`/api/projects/${projectId}/texts/${b.dataset.saveText}`, { method: 'PATCH', body: { content: ta.value } });
          toast('已保存', 'ok');
          renderProject(projectId);
        } catch (e) { toast(e.message, 'err'); }
      })
    );
    document.querySelectorAll('#wsCopySections [data-use-text]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api(`/api/projects/${projectId}/select-text`, { method: 'POST', body: { text_id: Number(b.dataset.useText) } });
          toast('已选用该版本', 'ok');
          renderProject(projectId);
        } catch (e) { toast(e.message, 'err'); }
      })
    );
  }

  /* 图墙 */
  function imgCell(x) {
    return `
      <div class="img-cell ${x.selected ? 'selected' : ''}" data-img-id="${x.id}" data-kind="${x.kind}">
        <img src="${esc(x.local_url || x.remote_url)}" alt="角色图 #${x.id}" loading="lazy" />
        ${x.selected ? '<span class="tick">✓</span>' : ''}
        <button class="del" data-del-img="${x.id}" title="删除">✕</button>
      </div>`;
  }

  function bindWallEvents(projectId) {
    document.querySelectorAll('#wsCharWall .img-cell').forEach((cell) => {
      cell.addEventListener('click', async () => {
        if (cell.classList.contains('selected')) return;
        try {
          await api(`/api/projects/${projectId}/select-image`, { method: 'POST', body: { image_id: Number(cell.dataset.imgId) } });
          toast('已定稿，后续视频将引用该角色图', 'ok');
          renderProject(projectId);
        } catch (e) { toast(e.message, 'err'); }
      });
      const del = cell.querySelector('.del');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('删除这张角色图？')) return;
        try {
          await api(`/api/images/${cell.dataset.imgId}`, { method: 'DELETE' });
          toast('已删除', 'ok');
          renderProject(projectId);
        } catch (e2) { toast(e2.message, 'err'); }
      });
    });
  }

  /* ---------------- 动作：生成文案 / 角色图 / 提交视频 ---------------- */

  async function genScript(projectId) {
    if (scriptBusy) return; // 防双击并发（两次 LLM 调用 + 两条重复版本）
    scriptBusy = true;
    await renderProject(projectId);
    try {
      const { project } = await api(`/api/projects/${projectId}`);
      const r = await api('/api/llm/script', {
        method: 'POST',
        body: { idea: project.idea, style: project.style, aspect_ratio: project.aspect_ratio, seconds: project.seconds, project_id: projectId },
      });
      if (!r.parsed) {
        toast('模型未按结构化输出（已保存到脚本区供手动采用）', 'warn');
      } else {
        toast('文案生成完成', 'ok');
      }
    } catch (e) {
      toast('文案生成失败：' + e.message, 'err');
    } finally {
      scriptBusy = false;
      // 用户可能已离开该项目视图，不强行拉回
      if (currentProjectId === projectId) await renderProject(projectId);
    }
  }

  async function genCharacterImage(projectId) {
    if (imgGenBusy) return; // 防双击并发
    const desc = $('#wsCharDesc')?.value.trim();
    if (!desc) { toast('请先填写角色外观描述', 'err'); return; }
    imgGenBusy = true;
    await renderProject(projectId);
    try {
      await api('/api/images/generate', {
        method: 'POST',
        body: {
          prompt: `角色立绘：${desc}。全身或半身构图，干净背景，正面站立，电影级写实，高细节`,
          size: $('#wsImgSize').value,
          ratio: $('#wsImgRatio').value,
          project_id: projectId,
          kind: 'character',
        },
      });
      toast('角色图已生成', 'ok');
    } catch (e) {
      toast('图片生成失败：' + e.message, 'err');
    } finally {
      imgGenBusy = false;
      if (currentProjectId === projectId) await renderProject(projectId);
    }
  }

  async function submitVideo(projectId) {
    const btn = $('#wsSubmitVideo');
    if (!btn || btn.disabled) return; // 防连点重复提交（每次提交都真实占用生成额度）
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const r = await api(`/api/projects/${projectId}/videos`, {
        method: 'POST',
        body: { seconds: $('#wsVSeconds').value, aspect_ratio: $('#wsVAspect').value },
      });
      toast(`视频任务 #${r.id} 已提交，可在任务中心跟踪`, 'ok');
      $('#navTasks')?.click();
      setTimeout(() => window.__app?.loadTasks?.(), 300);
    } catch (e) {
      toast('提交失败：' + e.message, 'err');
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = '🚀 提交视频任务';
      }
    }
  }

  // 暴露给 app.js 的视图切换 / 轮询循环使用
  window.__ws = { refresh, refreshTasks };
})();