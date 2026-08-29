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
  let currentStep = 1;        // 当前视区所在步骤（步骤条高亮跟随）

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 分阶段等待提示：每秒检查耗时，把 .ws-loading-text 换成对应阶段文案；返回停止函数 */
  function stageHints(selectors, stages) {
    const start = Date.now();
    const timer = setInterval(() => {
      const el = selectors.map((s) => document.querySelector(s)).find(Boolean);
      if (!el) return;
      const sec = (Date.now() - start) / 1000;
      let text = stages[0][1];
      for (const [from, msg] of stages) if (sec >= from) text = msg;
      el.textContent = text;
    }, 1000);
    return () => clearInterval(timer);
  }
  const STAGES_SCRIPT = [[0, '正在分析创意，梳理故事结构…'], [8, '正在撰写梗概与角色设定…'], [18, '即将完成，正在润色提示词…']];
  const STAGES_STORY = [[0, '正在拆解叙事节奏…'], [8, '正在设计镜头与运镜…'], [18, '即将完成，正在对齐镜头衔接…']];
  const STAGES_IMG = [[0, '正在生成候选图（约 10–90 秒），完成后在下方挑选…'], [30, '模型仍在绘制，请稍候…'], [60, '复杂画风耗时较长，马上好…']];

  /** 滚动时步骤条高亮跟随（只绑定一次；点击跳转后短暂抑制，避免覆盖用户选择） */
  let wsScrollBound = false;
  let stepFollowUntil = 0;
  function bindStepScrollFollow() {
    if (wsScrollBound) return;
    wsScrollBound = true;
    let timer = null;
    window.addEventListener('scroll', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!currentProjectId || $('#workspaceView')?.hidden) return;
        if (Date.now() < stepFollowUntil) return;
        const marks = [['#wsVideoSection', 4], ['#wsCharSection', 3], ['#wsCopySections', 2]];
        let cur = 1;
        const doc = document.documentElement;
        // 页面已滚到底 → 最后一步；否则取「顶部越过视口上沿 300px 内」的最近区块
        if (window.innerHeight + window.scrollY >= doc.scrollHeight - 60) {
          cur = 4;
        } else {
          for (const [sel, n] of marks) {
            const el = document.querySelector(sel);
            if (el && el.getBoundingClientRect().top <= 300) { cur = n; break; }
          }
        }
        currentStep = cur;
        document.querySelectorAll('.steps .step').forEach((s) => s.classList.toggle('active', s.dataset.step === String(cur)));
      }, 150);
    }, { passive: true });
  }
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
          <div class="field" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="npAutoStoryboard" checked style="width:auto" />
            <label for="npAutoStoryboard" style="margin:0;cursor:pointer">生成文案后自动生成分镜（一键到分镜，失败即停）</label>
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
        const autoStoryboard = $('#npAutoStoryboard', overlay)?.checked !== false;
        close();
        currentProjectId = p.id;
        await renderProject(p.id);
        toast('项目已创建，正在生成文案…', 'ok');
        // 一键到分镜：文案成功且勾选时自动接续生成分镜（失败即停）
        genScript(p.id).then(async (okScript) => {
          if (!okScript) {
            toast('文案生成失败，已停止自动分镜（可在第②步手动重试）', 'warn');
            return;
          }
          if (autoStoryboard) {
            toast('文案完成，自动生成分镜…', 'ok');
            await genStoryboard(p.id);
          }
        });
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
    const completedShots = tasks.filter((t) => t.status === 'completed').length;
    // v1.5：已绑定镜头配音的镜头数（渲染时旁白覆盖率提示）
    const narratedShots = shots.filter((s) => (d.tts || []).some((t) => t.kind === 'shot' && t.shot_id === s.id && t.local_path && !t.error_message)).length;
    const stepsDone = {
      1: Boolean(p.idea),
      2: texts.some((t) => t.kind === 'video_prompt' || t.kind === 'storyboard') || shots.length > 0,
      3: Boolean(selChar),
      4: tasks.length > 0, // M2 起 projects.status 退役，纯聚合推导
      5: (d.tts || []).length > 0,
      6: completedShots >= 2, // v1.3：≥2 个完成镜头即可渲染成片
    };
    const stepState = (n) => (stepsDone[n] ? 'done' : '');
    let renderJobs = [];
    try { renderJobs = (await api(`/api/projects/${id}/render/jobs`)).data.items || []; } catch { /* 旧后端兼容 */ }
    // 下一步引导：按当前产物状态给出唯一建议动作
    const guideInfo = (() => {
      if (!SCRIPT_FIELDS.some(([k]) => texts.some((t) => t.kind === k)) && !shots.length) {
        return { label: '生成文案与分镜', target: '#wsCopySections' };
      }
      if (!shots.length) return { label: '把创意拆解为分镜', target: '#wsCopySections' };
      if (!selChar) return { label: '生成并定稿一张角色图（视频将引用它保持角色一致）', target: '#wsCharSection' };
      if (!tasks.length) return { label: '提交第一个镜头的视频任务', target: '#wsVideoSection' };
      if (completedShots >= 2) return { label: '镜头已就绪：可一键渲染成片', target: '#wsRenderSection' };
      return { label: '全部就绪：可继续提交其他镜头，或在任务中心跟踪进度', target: null };
    })();

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
          <div class="step ${stepState(1)} ${currentStep === 1 ? 'active' : ''}" data-step="1"><span class="n">①</span>创意</div>
          <div class="step ${stepState(2)} ${currentStep === 2 ? 'active' : ''}" data-step="2"><span class="n">②</span>文案与提示词</div>
          <div class="step ${stepState(3)} ${currentStep === 3 ? 'active' : ''}" data-step="3"><span class="n">③</span>角色设定图</div>
          <div class="step ${stepState(4)} ${currentStep === 4 ? 'active' : ''}" data-step="4"><span class="n">④</span>视频生成</div>
          <div class="step ${stepState(5)} ${currentStep === 5 ? 'active' : ''}" data-step="5"><span class="n">⑤</span>配音</div>
          <div class="step ${stepState(6)} ${currentStep === 6 ? 'active' : ''}" data-step="6"><span class="n">⑥</span>成片</div>
        </div>
        ${guideInfo ? `<div class="ws-guide"><span>👉 下一步：<b>${esc(guideInfo.label)}</b></span><span class="spacer"></span>${guideInfo.target ? `<button class="btn ghost sm" data-guide-goto="${guideInfo.target}">前往</button>` : ''}</div>` : ''}

        <!-- ② 文案与分镜 -->
        <div class="copy-sect">
          <h4>📝 文案与提示词 <span class="badge-selected" hidden id="wsCopyDone">已生成</span></h4>
          ${scriptBusy ? '<div class="ws-loading"><span class="spinner"></span> <span class="ws-loading-text">正在分析创意，梳理故事结构…</span></div>' : `
          <button class="btn primary sm" id="wsGenScript">✨ 生成 / 重新生成文案</button>
          <div class="hint mt">梗概、角色描述、场景描述一次生成；分镜在下方独立生成与编辑。</div>`}
          <div id="wsCopySections" class="mt">
            ${storyBusy ? '<div class="ws-loading"><span class="spinner"></span> <span class="ws-loading-text">正在拆解叙事节奏…</span></div>' : renderStoryboardArea(texts, shots, p, meta)}
            ${renderTextSections(texts, ['script', 'character_desc', 'scene_desc'])}
          </div>
        </div>

        <!-- ③ 角色设定 -->
        <div class="copy-sect" id="wsCharSection">
          <h4>🧑‍🎨 角色设定图 <span class="muted" style="font-weight:400">（参考图用于视频，减少角色幻觉）</span></h4>
          <div class="grid2">
            <div class="field"><label>角色外观描述（可手动调整）</label>
              <textarea id="wsCharDesc" rows="3">${esc((texts.find((t) => t.kind === 'character_desc' && t.selected) || texts.find((t) => t.kind === 'character_desc') || {}).content || p.idea || '')}</textarea>
              <div class="row" style="margin-top:6px;display:flex;gap:8px;align-items:center">
                <button class="btn ghost sm" id="wsOptimizeChar" title="用文本模型优化角色描述，优化后可对比选择是否采用">✨ AI 优化描述</button>
                <span class="hint">是否用 AI 优化由你决定，优化后会先对比再采用。</span>
              </div>
            </div>
            <div class="field">
              <label>画幅 / 分辨率档位</label>
              <div class="grid2">
                <select id="wsImgRatio">${meta.image.ratios.map((a) => `<option value="${esc(a)}" ${a === '1:1' ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
                <select id="wsImgSize">${meta.image.sizes.map((s) => `<option value="${esc(s)}" ${s === '1K' ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
              </div>
              ${imgGenBusy
                ? '<div class="ws-loading mt"><span class="spinner"></span> <span class="ws-loading-text">正在生成候选图（约 10–90 秒），完成后在下方挑选…</span></div>'
                : `<div class="row mt" style="display:flex;gap:8px;align-items:center">
                    <select id="wsImgCount" class="meta-tag" style="background:var(--bg)" title="一次生成的候选图数量">
                      <option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option>
                    </select>
                    <button class="btn primary sm" id="wsGenChar">🎨 生成角色图</button>
                  </div>`}
              <div class="hint mt">生成多张时点击其一作为种子图（绿色边框定稿）；不满意可再生成。</div>
            </div>
          </div>
          <div class="img-wall mt" id="wsCharWall">${images.filter((x) => x.kind === 'character').map(imgCell).join('')}</div>
        </div>

        <!-- ④ 视频 -->
        <div class="copy-sect" id="wsVideoSection">
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

        <!-- ⑤ 配音（Fish Audio TTS） -->
        <div class="copy-sect" id="wsTtsSection">
          <h4>🎙️ 配音（旁白 · Fish Audio TTS） <span class="muted" style="font-weight:400">可选：把文案/分镜变成人声旁白，混入成片</span></h4>
          <div class="grid2">
            <div class="field">
              <label>配音文稿（可手动编辑；支持多句分段，每句一行）</label>
              <textarea id="wsTtsText" rows="4" placeholder="粘贴要配音的文稿…">${esc(defaultTtsText(texts, shots))}</textarea>
              <div class="row" style="margin-top:6px;display:flex;gap:8px;align-items:center">
                <button class="btn ghost sm" id="wsTtsFillNarration" title="用选定分镜的旁白行填充">📖 从分镜填充旁白</button>
                <button class="btn ghost sm" id="wsTtsFillScript" title="用选定故事梗概填充">✍️ 从故事梗概填充</button>
                <span class="hint">每行一句；生成后逐句合成，第一句自动选用。</span>
              </div>
            </div>
            <div class="field">
              <label>音色 / 语速</label>
              <div class="grid2">
                <select id="wsTtsVoice"></select>
                <input type="number" id="wsTtsSpeed" min="0.5" max="2" step="0.05" value="${esc(String(wsDefaultSpeed()))}" title="语速 0.5–2.0（旁白建议 0.9–1.0）" />
              </div>
              <div class="row mt" style="display:flex;gap:8px;align-items:center">
                <button class="btn primary sm" id="wsTtsGen">🗣️ 生成配音</button>
                <span class="hint" id="wsTtsHint"></span>
              </div>
              <div class="hint mt">配音为本地 mp3（存 data/artifacts），可在浏览器试听、选用；「下载」可拿去做后期混音。</div>
            </div>
          </div>
          <div id="wsTtsWall" class="mt">${renderTtsWall(d.tts || [], shots)}</div>
        </div>

        <!-- ⑥ 成片渲染（v1.3） -->
        <div class="copy-sect" id="wsRenderSection">
          <h4>🎞️ 成片渲染 <span class="muted" style="font-weight:400">已完成镜头 + 逐镜旁白 → 完整短片（本地 ffmpeg 合成）</span></h4>
          <div class="row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <select id="wsRAspect" class="meta-tag" style="background:var(--bg)" title="成片方向（默认跟随项目画幅）">
              <option value="16:9" ${p.aspect_ratio !== '9:16' ? 'selected' : ''}>横屏 16:9</option>
              <option value="9:16" ${p.aspect_ratio === '9:16' ? 'selected' : ''}>竖屏 9:16</option>
            </select>
            <label class="hint" style="display:flex;gap:6px;align-items:center">叠化
              <select id="wsRTransition" class="meta-tag" style="background:var(--bg)" title="镜头间叠化时长">
                <option value="400">0.4s</option><option value="600" selected>0.6s</option><option value="1000">1.0s</option>
              </select></label>
            <label class="hint" style="display:flex;gap:6px;align-items:center">旁白偏移
              <select id="wsRNarrOffset" class="meta-tag" style="background:var(--bg)" title="旁白相对镜头起幅点的进入时间">
                <option value="300">0.3s</option><option value="500" selected>0.5s</option><option value="1000">1.0s</option>
              </select></label>
            <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsRTitle" checked /> 片头卡</label>
            <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsREnd" checked /> 片尾卡</label>
            <label class="hint" style="display:flex;gap:6px;align-items:center">BGM 音量
              <input type="range" id="wsRBgmVol" min="5" max="90" value="35" style="width:90px" title="背景音乐音量（有旁白时建议 30–40%）" />
              <span id="wsRBgmVolV">35%</span></label>
            <label class="hint" style="display:flex;gap:6px;align-items:center">旁白增益
              <input type="range" id="wsRNarrVol" min="80" max="220" value="140" style="width:90px" title="旁白音量增益（默认 140%，让人声稳坐音乐之上）" />
              <span id="wsRNarrVolV">140%</span></label>
            <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsRDuck" checked /> 旁白闪避</label>
            <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsRSubs" checked /> 烧录字幕</label>
            <select id="wsRSubSize" class="meta-tag" style="background:var(--bg)" title="字幕字号">
              <option value="36">小字</option><option value="42" selected>中字</option><option value="52">大字</option>
            </select>
            <span class="meta-tag" title="已绑定镜头配音的镜头数（在第⑤步配音墙中绑定）">🎙️ 旁白 ${narratedShots}/${shots.length} 镜</span>
            <span class="spacer" style="flex:1"></span>
            <button class="btn primary" id="wsRenderBtn" ${completedShots >= 2 ? '' : 'disabled'} title="${completedShots >= 2 ? '创建后台渲染任务' : '至少需要 2 个已完成镜头'}">🎞️ 渲染成片（${completedShots} 镜就绪）</button>
          </div>
          <div class="hint mt">旁白取每个镜头最新绑定的配音（第⑤步配音墙中「绑定到镜头」）；混音链：旁白高通+压缩+增益 → BGM 循环铺底+首尾淡入淡出 → 旁白闪避 → 全片响度标准化（-16 LUFS）。成片 1280×720@30，服务端后台渲染。</div>
          <div class="mt" style="border-top:1px dashed #2a3244;padding-top:10px">
            <b>🎵 背景音乐（BGM）</b> <span class="hint">搜索在线曲库选用一首，渲染时循环铺底、首尾淡入淡出；有旁白时自动闪避（压低音乐让人声突出）</span>
            <div class="row" style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
              <input id="wsBgmQuery" placeholder="搜索歌曲 / 歌手，如：夜空中最亮的星" style="flex:1;min-width:200px" />
              <button class="btn ghost sm" id="wsBgmSearch">🔍 搜索</button>
            </div>
            <div id="wsBgmCurrent" class="mt">${bgmCurrentHtml(p.bgm)}</div>
            <div id="wsBgmResults" class="mt"></div>
            <audio id="wsBgmAudio" preload="none" style="display:none"></audio>
          </div>
          <div id="wsRenderJobs" class="mt">${renderJobs.map(renderJobItem).join('')}</div>
        </div>
      </div>`;

    $('#wsBack').onclick = () => { currentProjectId = null; renderList(); };
    // 步骤条点击跳转 + 下一步引导
    const stepTargets = { 1: '#wsCopySections', 2: '#wsCopySections', 3: '#wsCharSection', 4: '#wsVideoSection', 5: '#wsTtsSection', 6: '#wsRenderSection' };
    ws.querySelectorAll('.step[data-step]').forEach((el) => {
      el.onclick = () => {
        currentStep = Number(el.dataset.step);
        stepFollowUntil = Date.now() + 1500; // 滚动途中不让跟随逻辑覆盖点击选择
        document.querySelectorAll('.steps .step').forEach((s) => s.classList.toggle('active', s === el));
        document.querySelector(stepTargets[currentStep])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    const guideBtn = ws.querySelector('[data-guide-goto]');
    if (guideBtn) {
      guideBtn.onclick = () => document.querySelector(guideBtn.dataset.guideGoto)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    bindStepScrollFollow();
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
    const optCharBtn = $('#wsOptimizeChar');
    if (optCharBtn) optCharBtn.onclick = () => optimizeCharDesc(p.id);
    const submitVideoBtn = $('#wsSubmitVideo');
    if (submitVideoBtn) submitVideoBtn.onclick = () => submitVideo(p.id);
    bindTextSectionEvents(p.id);
    bindWallEvents(p.id);
    bindStoryboardEvents(p.id);
    // M2 第④步：镜头提交 / 批量提交 / 停止
    document.querySelectorAll('#wsShotSubmit [data-shot-submit]').forEach((b) => {
      b.onclick = () => submitShot(p.id, Number(b.dataset.shotSubmit));
    });
    // v1.7 重拍与定稿选条
    document.querySelectorAll('#wsShotSubmit [data-shot-retake]').forEach((b) => {
      b.onclick = async () => {
        const shotId = Number(b.dataset.shotRetake);
        b.disabled = true;
        try {
          const r = await api(`/api/projects/${p.id}/shots/${shotId}/retakes`, { method: 'POST', body: { count: 1 } });
          toast(`重拍任务 #${r.retakes[0].id} 已入队（完成后在下方候选区选定）`, 'ok');
          window.__app?.loadTasks?.();
          if (currentProjectId === p.id) await renderProject(p.id);
        } catch (e) {
          toast('重拍失败：' + e.message, 'err');
          b.disabled = false;
        }
      };
    });
    document.querySelectorAll('#wsShotSubmit [data-take-pick]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/projects/${p.id}/shots/${Number(b.dataset.takePick)}/select-take`, { method: 'POST', body: { task_id: Number(b.dataset.task) } });
          toast('已选定定稿 take，成片渲染将优先使用这条', 'ok');
          await renderProject(p.id);
        } catch (e) { toast('选定失败：' + e.message, 'err'); }
      };
    });
    document.querySelectorAll('#wsShotSubmit [data-take-auto]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/projects/${p.id}/shots/${Number(b.dataset.takeAuto)}/select-take`, { method: 'POST', body: { task_id: null } });
          toast('已恢复自动模式（渲染用最新完成条）', 'ok');
          await renderProject(p.id);
        } catch (e) { toast(e.message, 'err'); }
      };
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
    // TTS 配音事件
    bindTtsEvents(p.id);
    // v1.3 成片渲染
    const rbtn = $('#wsRenderBtn');
    if (rbtn) {
      rbtn.onclick = async () => {
        rbtn.disabled = true;
        try {
          await api(`/api/projects/${p.id}/render`, {
            method: 'POST',
            body: {
              transition_ms: Number($('#wsRTransition')?.value || 600),
              narration_offset_ms: Number($('#wsRNarrOffset')?.value || 500),
              title_card: $('#wsRTitle')?.checked !== false,
              end_card: $('#wsREnd')?.checked !== false,
              bgm_volume: Number($('#wsRBgmVol')?.value || 35) / 100,
              bgm_duck: $('#wsRDuck')?.checked !== false,
              narration_volume: Number($('#wsRNarrVol')?.value || 140) / 100,
              burn_subtitles: $('#wsRSubs')?.checked !== false,
              subtitle_fontsize: Number($('#wsRSubSize')?.value || 42),
              aspect: $('#wsRAspect')?.value || '16:9',
            },
          });
          toast('渲染任务已创建，后台合成中（可离开本页）', 'ok');
          await renderProject(p.id);
        } catch (e) {
          toast('渲染失败：' + e.message, 'err');
          rbtn.disabled = false;
        }
      };
    }
    if (renderJobs.some((j) => j.status === 'queued' || j.status === 'rendering')) startRenderPoll(p.id);
    // v1.4 BGM：搜索 / 试听 / 选用 / 清除
    let bgmAudio = null;
    let bgmAudioUrl = '';
    const bgmSearchBtn = $('#wsBgmSearch');
    if (bgmSearchBtn) {
      bgmSearchBtn.onclick = async () => {
        const q = $('#wsBgmQuery').value.trim();
        if (!q) return toast('请输入搜索关键词', 'warn');
        bgmSearchBtn.disabled = true;
        try {
          const r = await api(`/api/music/search?limit=8&keyword=${encodeURIComponent(q)}`);
          const box = $('#wsBgmResults');
          const items = r.items || [];
          box.innerHTML = items.length ? items.map((s) => `
            <div class="ver-item" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span><b>${esc(s.name)}</b> ${esc(s.artist)}${s.album ? ` · <span class="muted">${esc(s.album)}</span>` : ''}</span>
              <span class="meta-tag">${fmtSecs(s.duration_s)}</span>
              <span class="spacer" style="flex:1"></span>
              <button class="btn ghost sm" data-bgm-play="${s.id}" data-level="${esc(s.levels?.[1] || 'exhigh')}">▶ 试听</button>
              <button class="btn ghost sm" data-bgm-pick="${s.id}" data-name="${esc(s.name)}" data-artist="${esc(s.artist)}" data-album="${esc(s.album)}">选用</button>
            </div>`).join('') : '<span class="hint">没有找到结果</span>';
          box.querySelectorAll('[data-bgm-play]').forEach((b) => {
            b.onclick = () => {
              if (!bgmAudio) bgmAudio = new Audio();
              const url = `/api/music/stream?id=${b.dataset.bgmPlay}&level=${b.dataset.level}`;
              if (bgmAudioUrl === url) {
                if (bgmAudio.paused) bgmAudio.play().catch(() => toast('试听加载失败', 'err'));
                else bgmAudio.pause();
                return;
              }
              bgmAudioUrl = url;
              bgmAudio.src = url;
              bgmAudio.play().catch(() => toast('试听加载失败（检查设置中的音乐接口配置）', 'err'));
            };
          });
          box.querySelectorAll('[data-bgm-pick]').forEach((b) => {
            b.onclick = async () => {
              b.disabled = true;
              try {
                await api(`/api/projects/${p.id}/bgm`, { method: 'POST', body: {
                  song_id: b.dataset.bgmPick, name: b.dataset.name, artist: b.dataset.artist, album: b.dataset.album,
                } });
                toast('BGM 已选用（已下载到本地缓存）', 'ok');
                await renderProject(p.id);
              } catch (e) {
                toast('选用失败：' + e.message, 'err');
                b.disabled = false;
              }
            };
          });
        } catch (e) {
          toast('搜索失败：' + e.message, 'err');
        } finally {
          bgmSearchBtn.disabled = false;
        }
      };
    }
    const bgmClear = $('#wsBgmClear');
    if (bgmClear) {
      bgmClear.onclick = async () => {
        try {
          await api(`/api/projects/${p.id}/bgm`, { method: 'DELETE' });
          toast('已清除 BGM 选择', 'ok');
          await renderProject(p.id);
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    const volRange = $('#wsRBgmVol');
    if (volRange) {
      volRange.oninput = () => {
        const l = $('#wsRBgmVolV');
        if (l) l.textContent = volRange.value + '%';
      };
    }
    const narrRange = $('#wsRNarrVol');
    if (narrRange) {
      narrRange.oninput = () => {
        const l = $('#wsRNarrVolV');
        if (l) l.textContent = narrRange.value + '%';
      };
    }
  }

  /* ---------------- TTS 配音（Fish Audio） ---------------- */
  let wsSettingsCache = null;
  function wsDefaultSpeed() {
    return wsSettingsCache?.fish_speed ?? 1;
  }
  function defaultTtsText(texts, shots) {
    // 优先：分镜已有旁白行（video_prompt 首段）→ 故事梗概
    if (shots.length) {
      const lines = shots
        .map((s) => (s.title || '') + '。' + (s.video_prompt || '').split(/[。\n]/)[0])
        .filter(Boolean);
      if (lines.length) return lines.join('\n');
    }
    const script = (texts.find((t) => t.kind === 'script' && t.selected) || texts.find((t) => t.kind === 'script'));
    return script ? script.content : '';
  }

  async function loadMetaVoices() {
    let meta = META;
    let voices = [];
    try {
      const r = await fetch('/api/tts/voices');
      if (r.ok) { const j = await r.json(); voices = j.voices || []; }
    } catch { /* ignore */ }
    return voices;
  }

  async function bindTtsEvents(projectId) {
    const genBtn = $('#wsTtsGen');
    const voiceSel = $('#wsTtsVoice');
    if (!genBtn || !voiceSel) return;
    // 加载音色清单（含设置里的默认音色）
    const voices = await loadMetaVoices();
    let curVoice = 'default';
    try {
      const s = await api('/api/settings');
      wsSettingsCache = s;
      curVoice = s.fish_voice || 'default';
    } catch { /* ignore */ }
    if (voiceSel) {
      voiceSel.innerHTML = voices
        .map((v) => `<option value="${esc(v.id)}" ${v.id === curVoice ? 'selected' : ''}>${esc(v.title)}</option>`)
        .join('');
    }
    // TTS 墙内按钮（试听/选用/删除/绑定镜头）——事件委托
    const wall = $('#wsTtsWall');
    if (wall) {
      wall.addEventListener('change', async (ev) => {
        const sel = ev.target.closest('[data-tts-bind]');
        if (!sel) return;
        const item = sel.closest('[data-tts-id]');
        const id = Number(item?.dataset.ttsId);
        if (!id) return;
        const shotId = sel.value ? Number(sel.value) : null;
        try {
          await api(`/api/tts/${id}/bind`, { method: 'POST', body: { project_id: projectId, shot_id: shotId } });
          toast(shotId ? '已绑定镜头：成片渲染时按镜头对齐混入' : '已解绑为整片旁白素材', 'ok');
          if (currentProjectId === projectId) await renderProject(projectId);
        } catch (e) { toast('绑定失败：' + e.message, 'err'); }
      });
      wall.onclick = async (ev) => {
        const playBtn = ev.target.closest('[data-tts-play]');
        if (playBtn) {
          ev.stopPropagation();
          const url = playBtn.dataset.ttsPlay;
          if (window.__audio?.preview) return window.__audio.preview(url, playBtn);
          const au = playBtn._au || (playBtn._au = new Audio(url));
          if (au.paused && !au.ended) au.play(); else { au.currentTime = 0; au.play(); }
          return;
        }
        const selBtn = ev.target.closest('[data-tts-select]');
        if (selBtn) {
          ev.stopPropagation();
          const item = selBtn.closest('[data-tts-id]');
          const id = Number(item?.dataset.ttsId);
          if (!id) return;
          try {
            await api(`/api/tts/${id}/select`, { method: 'POST', body: { project_id: projectId } });
            toast('已选用该配音', 'ok');
            if (currentProjectId === projectId) await renderProject(projectId);
          } catch (e) { toast('选用失败：' + e.message, 'err'); }
          return;
        }
        const delBtn = ev.target.closest('[data-tts-del]');
        if (delBtn) {
          ev.stopPropagation();
          const item = delBtn.closest('[data-tts-id]');
          const id = Number(item?.dataset.ttsId);
          if (!id) return;
          if (!confirm('删除该配音记录与本地音频？')) return;
          try {
            await api(`/api/tts/${id}`, { method: 'DELETE' });
            toast('已删除配音', 'ok');
            if (currentProjectId === projectId) await renderProject(projectId);
          } catch (e) { toast('删除失败：' + e.message, 'err'); }
        }
      };
    }
    const fillN = $('#wsTtsFillNarration');
    if (fillN) fillN.onclick = async () => {
      const d = await api(`/api/projects/${projectId}`);
      const ta = $('#wsTtsText');
      if (ta) ta.value = defaultTtsText(d.texts || [], d.shots || []);
      toast('已用分镜填充旁白文稿，可再编辑', 'ok');
    };
    const fillS = $('#wsTtsFillScript');
    if (fillS) fillS.onclick = async () => {
      const d = await api(`/api/projects/${projectId}`);
      const s = (d.texts || []).find((t) => t.kind === 'script' && t.selected) || (d.texts || []).find((t) => t.kind === 'script');
      const ta = $('#wsTtsText');
      if (ta && s) ta.value = s.content;
      toast('已用故事梗概填充', 'ok');
    };
    genBtn.onclick = () => genTts(projectId);
  }

  async function genTts(projectId) {
    const ta = $('#wsTtsText');
    const text = ta ? ta.value.trim() : '';
    if (!text) { toast('请先输入配音文稿', 'err'); return; }
    const voice = $('#wsTtsVoice')?.value || 'default';
    const speed = Number($('#wsTtsSpeed')?.value || 1);
    const genBtn = $('#wsTtsGen');
    const hint = $('#wsTtsHint');
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = '生成中…'; }
    if (hint) hint.textContent = '正在合成，可能需要 10–60 秒…';
    try {
      const r = await api('/api/tts/generate', {
        method: 'POST',
        body: { text, voice, speed, kind: 'narration', project_id: projectId },
      });
      toast(`配音已生成（${r.duration ?? '?'}s · ${r.voice_title || ''}）`, 'ok');
      if (currentProjectId === projectId) await renderProject(projectId);
    } catch (e) {
      toast('配音生成失败：' + e.message, 'err');
      if (hint) hint.textContent = '';
    } finally {
      if (genBtn) { genBtn.disabled = false; genBtn.textContent = '🗣️ 生成配音'; }
    }
  }

  function renderTtsWall(list, shots = []) {
    if (!list || !list.length) return '<div class="hint">还没有配音记录。填入文稿后点「🗣️ 生成配音」。</div>';
    const shotOpts = (cur) => ['<option value="">旁白（未绑镜头）</option>']
      .concat(shots.map((s) => `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>镜头 ${s.seq}${s.title ? ' · ' + esc(s.title) : ''}</option>`))
      .join('');
    return `
      <div class="tts-wall">
        ${list.map((t) => {
          const bound = t.kind === 'shot' && t.shot_id;
          const boundShot = bound ? shots.find((s) => s.id === t.shot_id) : null;
          return `
          <div class="tts-item ${t.selected ? 'selected' : ''}" data-tts-id="${t.id}" style="border:1px solid ${t.selected ? 'var(--accent,#2b8a5a)' : 'var(--line,#e3e3e3)'};border-radius:8px;padding:10px 12px;margin-bottom:8px;background:${t.selected ? 'var(--bg-soft,#f2f8f4)' : 'transparent'}">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span class="meta-tag">${esc(t.voice_title || t.reference_id || '默认音色')}</span>
              <span class="meta-tag">${esc(t.model || '')}</span>
              <span class="meta-tag">${t.duration != null ? t.duration + 's' : '—'}</span>
              <span class="meta-tag">${t.size != null ? Math.round(t.size / 1024) + 'KB' : '—'}</span>
              ${bound ? `<span class="meta-tag" title="已绑定镜头，成片渲染时按镜头对齐混入">🎬 镜头 ${boundShot ? boundShot.seq : '?'}</span>` : ''}
              ${t.selected ? '<span class="badge-selected">✓ 选用</span>' : ''}
              <span class="spacer" style="flex:1"></span>
              ${t.local_url ? `<button class="btn ghost sm" data-tts-play="${esc(t.local_url)}">▶ 试听</button>` : ''}
              ${!t.selected && t.local_url ? '<button class="btn ghost sm" data-tts-select>选用</button>' : ''}
              <button class="btn ghost sm danger" data-tts-del title="删除记录与本地音频">删除</button>
            </div>
            <div style="margin-top:6px;color:var(--muted,#888);font-size:12px">${esc(t.text || '')}</div>
            ${t.local_url && !t.error_message && shots.length ? `
            <div style="margin-top:6px;display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted,#888)">
              绑定到镜头（成片渲染按镜头对齐混入）：
              <select class="meta-tag" data-tts-bind style="background:var(--bg)">${shotOpts(bound ? t.shot_id : null)}</select>
            </div>` : ''}
            ${t.error_message ? `<div style="margin-top:4px;color:var(--danger,#c0392b);font-size:12px">失败：${esc(t.error_message)}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div class="hint mt">提示：「绑定到镜头」的配音会在成片渲染时按镜头起幅点自动对齐混入（同一镜头多次绑定以最新一条为准）；未绑定的记录仅作整片旁白素材保留。</div>`;
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

  /* 角色描述 AI 优化（用户自主选择是否采用，优化后先对比） */
  const CHAR_OPTIMIZE_PROMPT = '你是角色设定师。把用户的角色描述优化为适合 AI 角色立绘生成的设定文本，100 字内，必含要素：性别年龄、发型发色、五官特征、表情气质、服装款式与颜色、体型、有辨识度的配饰。规则：不添加用户未提及的职业、背景等设定；保持原描述的核心特征不变；只输出设定文本本身，不要任何解释或前缀。';

  async function optimizeCharDesc(projectId) {
    const ta = $('#wsCharDesc');
    if (!ta) return;
    const cur = ta.value.trim();
    if (!cur) { toast('请先填写角色外观描述', 'err'); return; }
    const btn = $('#wsOptimizeChar');
    if (btn) { btn.disabled = true; btn.textContent = '优化中…'; }
    try {
      const r = await api('/api/llm/chat', {
        method: 'POST',
        body: { system: CHAR_OPTIMIZE_PROMPT, messages: [{ role: 'user', content: cur }], temperature: 0.7 },
      });
      const adopt = () => {
        ta.value = r.content;
        toast('已采用优化描述（需点「生成角色图」才会生效，或手动保存到文案）', 'ok');
      };
      if (window.__ui?.compare) {
        window.__ui.compare({
          title: '角色描述优化对比',
          oldLabel: '当前描述',
          newLabel: 'AI 优化后',
          oldText: cur,
          newText: r.content,
          onAdopt: adopt,
          onKeep: () => toast('已保留当前描述', 'ok'),
        });
      } else {
        adopt();
      }
    } catch (e) {
      toast('优化失败：' + e.message, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨ AI 优化描述'; }
    }
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
      <div class="hint mt">镜头默认引用定稿角色图（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」）；纯空镜镜头可在上方分镜卡片中取消勾选「引用角色图」。</div>
      <div id="wsShotSubmit" class="mt">
        ${shots.map((s) => {
          const t = shotLatestTask(tasks, s.id);
          const active = t && (t.status === 'queued' || t.status === 'in_progress');
          const takes = tasks.filter((x) => x.shot_id === s.id && x.status === 'completed').sort((a, b) => b.id - a.id);
          return `
          <div class="ver-item shot-submit-row">
            <b>镜头 ${s.seq}</b>${s.title ? ` · ${esc(s.title)}` : ''}
            <span class="meta-tag">${esc(String(s.seconds || '5'))}s</span>
            ${shotStatusBadge(t)}
            <span class="spacer" style="flex:1"></span>
            <button class="btn ghost sm" data-shot-retake="${s.id}" ${batchBusy ? 'disabled' : ''} title="为该镜头再生成一条候选（提交队列自动按分钟节流）">📸 重拍</button>
            <button class="btn primary sm" data-shot-submit="${s.id}" ${selChar && !active && !batchBusy ? '' : 'disabled'}>🚀 提交</button>
            ${takes.length ? `
            <div style="width:100%;margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px">
              <span class="hint">候选 ${takes.length} 条（渲染${s.take_task_id ? '用 ✓定稿' : '默认用最新'}）：</span>
              ${takes.map((tk) => `
                <span class="meta-tag" style="${tk.id === s.take_task_id ? 'border-color:#2b8a5a;color:#2b8a5a' : ''}">#${tk.id}${tk.id === s.take_task_id ? ' ✓定稿' : ''}</span>
                ${tk.id === s.take_task_id
                  ? `<button class="btn ghost sm" data-take-auto="${s.id}" title="恢复自动模式（渲染用最新完成条）">取消定稿</button>`
                  : `<button class="btn ghost sm" data-take-pick="${s.id}" data-task="${tk.id}" title="渲染时优先使用这条">用这条</button>`}
              `).join('')}
            </div>` : ''}
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
      <div class="hint mt">批量提交按设置中的「批量提交间隔」逐个发起；服务端提交队列也按同一间隔节流并自动重试限流（429）——即使关闭页面，已入队任务也会由后台继续提交。</div>`;
  }

  async function submitShot(projectId, shotId) {
    const btn = document.querySelector(`[data-shot-submit="${shotId}"]`);
    if (!btn || btn.disabled) return; // 防连点重复提交
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const r = await api(`/api/projects/${projectId}/shots/${shotId}/videos`, { method: 'POST', body: {} });
      toast(`镜头任务 #${r.id} 已入队（后台提交器将按间隔自动提交）`, 'ok');
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
            <textarea data-shot-narration rows="2" placeholder="旁白文案（可选；成片渲染时按镜头合成配音并对齐时间轴）" style="margin-top:6px">${esc(s.narration || '')}</textarea>
            <label class="hint" style="display:flex;gap:6px;align-items:center;margin-top:6px">
              <input type="checkbox" data-shot-ref ${s.use_character_ref !== 0 ? 'checked' : ''} />
              引用角色定稿图（纯空镜 / 无人镜头可取消勾选，将以纯文生模式提交）
            </label>
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
                narration: card.querySelector('[data-shot-narration]').value,
                use_character_ref: card.querySelector('[data-shot-ref]').checked,
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
    if (currentShotCount > 0 && !confirm('重新生成分镜：将先与当前分镜对比，由你选择采用（历史版本保留），继续？')) return;
    storyBusy = true;
    await renderProject(projectId);
    let stopHints = null;
    try {
      stopHints = stageHints(['#wsCopySections .ws-loading-text'], STAGES_STORY);
      const d = await api(`/api/projects/${projectId}`);
      const project = d.project;
      const oldShots = d.shots || [];
      const hasOld = oldShots.length > 0;
      const r = await api('/api/llm/storyboard', {
        method: 'POST',
        body: {
          idea: project.idea,
          style: project.style,
          aspect_ratio: project.aspect_ratio,
          seconds: project.seconds,
          shot_count: $('#wsShotCount')?.value || 'auto',
          project_id: projectId,
          auto_select: !hasOld,
        },
      });
      if (!r.parsed) {
        toast('模型未按结构化输出分镜（原始输出已保存到脚本区供参考）', 'warn');
        return;
      }
      if (!hasOld) {
        toast(`分镜已生成（${r.shots?.length ?? 0} 个镜头）`, 'ok');
        return;
      }
      // 新旧分镜对比：采用 = 选中新版本并重建镜头；保留 = 新版本仅入历史
      const renderShots = (arr) => (arr || [])
        .map((s, i) => `<div class="cmp-field"><b>镜头 ${esc(String(s.seq ?? i + 1))}${s.title ? ` · ${esc(s.title)}` : ''}</b><p>${esc(s.video_prompt || '')}</p></div>`)
        .join('');
      window.__ui.compare({
        title: '新生成分镜与当前分镜对比',
        oldLabel: `当前分镜（${oldShots.length} 镜）`,
        newLabel: `新生成（${r.shots?.length ?? 0} 镜）`,
        oldText: oldShots,
        newText: r.shots,
        renderText: renderShots,
        onAdopt: async () => {
          try {
            await api(`/api/projects/${projectId}/storyboard/apply`, { method: 'POST', body: { text_id: r.text_id } });
            toast('已采用新分镜', 'ok');
          } catch (e) { toast(e.message, 'err'); }
          if (currentProjectId === projectId) await renderProject(projectId);
        },
        onKeep: async () => {
          toast('已保留当前分镜（新版本已存入历史，可随时选用）', 'ok');
          if (currentProjectId === projectId) await renderProject(projectId);
        },
      });
    } catch (e) {
      toast('分镜生成失败：' + e.message, 'err');
    } finally {
      storyBusy = false;
      stopHints?.();
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
    const row = (t) => {
      const playSrc = t.video_local_url || t.metadata_url; // v1.3：本地归档优先（远端链接会过期）
      return `
      <div class="ver-item">
        #${t.id} · ${esc(STATUS_LABEL[t.status] || t.status)} · ${Number(t.progress) > 0 ? `${Number(t.progress)}%` : ''} · ${fmtTime(t.created_at)}
        ${t.superseded ? '<span class="meta-tag" title="该镜头已有更新成功的任务，此失败记录仅供参考">已作废</span>' : ''}
        ${t.status === 'completed' && playSrc ? `<a class="act green" href="${esc(playSrc)}" target="_blank" rel="noopener">播放/下载${t.video_local_url ? '（本地）' : ''}</a>` : ''}
        <a class="act" href="#" data-goto-task="${t.id}" style="margin-left:auto">去任务中心查看</a>
      </div>`;
    };
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

  /* ---------------- v1.3 成片渲染面板 ---------------- */
  const RENDER_STATUS = { queued: '排队中', rendering: '渲染中', completed: '已完成', failed: '失败' };

  function bgmCurrentHtml(bgm) {
    if (!bgm?.song_id) return '<span class="hint">未选用 BGM（可选：选用后渲染时循环铺底，有旁白时自动闪避）</span>';
    return `<span class="meta-tag">🎵 ${esc(bgm.name)}${bgm.artist ? ' - ' + esc(bgm.artist) : ''}</span>
      <span class="meta-tag">${esc(bgm.level || '')}</span>
      <button class="btn ghost sm" id="wsBgmClear" title="清除 BGM 选择（本地缓存保留）">✕ 清除</button>`;
  }

  function fmtSecs(s) {
    const n = Math.max(0, Math.round(Number(s) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  }

  function renderJobItem(j) {
    const active = j.status === 'queued' || j.status === 'rendering';
    return `
    <div class="ver-item" data-render-job="${j.id}">
      <b>渲染 #${j.id}</b> · ${esc(RENDER_STATUS[j.status] || j.status)}${active ? ` · ${j.progress || 0}%` : ''} · ${fmtTime(j.created_at)}
      ${active ? `<div style="height:6px;background:var(--bg,#1a1f2b);border-radius:3px;overflow:hidden;margin-top:6px"><div style="height:100%;width:${j.progress || 0}%;background:#4f7cff;transition:width .5s"></div></div>` : ''}
      ${j.status === 'completed' && j.output_url ? `<div style="margin-top:6px"><video controls preload="metadata" src="${esc(j.output_url)}" style="max-width:100%;border-radius:6px"></video>
        <div style="margin-top:6px"><a class="btn ghost sm" href="${esc(j.output_url)}" download>⬇️ 下载成片</a></div></div>` : ''}
      ${(j.covers || []).length ? `<div style="margin-top:6px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <span class="hint">封面候选：</span>
        ${j.covers.map((c) => `<a href="${esc(c.url)}" download title="点击下载封面"><img src="${esc(c.url)}" style="height:72px;border-radius:4px;border:1px solid #333" /></a>`).join('')}
      </div>` : ''}
      ${j.error_message ? `<div class="hint" style="color:#e5484d;margin-top:4px">✗ ${esc(j.error_message)}</div>` : ''}
    </div>`;
  }

  let renderPollTimer = null;
  /** 渲染任务进行中：轮询刷新进度条；全部落定后整页刷新一次（启用下载/更新步骤状态） */
  function startRenderPoll(projectId) {
    clearInterval(renderPollTimer);
    renderPollTimer = setInterval(async () => {
      if (currentProjectId !== projectId) {
        clearInterval(renderPollTimer);
        renderPollTimer = null;
        return;
      }
      let jobs = [];
      try { jobs = (await api(`/api/projects/${projectId}/render/jobs`)).data.items || []; } catch { return; }
      const box = $('#wsRenderJobs');
      if (box) box.innerHTML = jobs.map(renderJobItem).join('');
      if (!jobs.some((j) => j.status === 'queued' || j.status === 'rendering')) {
        clearInterval(renderPollTimer);
        renderPollTimer = null;
        await renderProject(projectId);
      }
    }, 2000);
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

  const SCRIPT_FIELDS = [
    ['script', '故事梗概'],
    ['video_prompt', '视频提示词'],
    ['character_desc', '角色外观'],
    ['scene_desc', '场景描述'],
  ];

  /** 生成文案：首次生成直接采用；已有文案时落库不选中，弹对比窗由用户二选一。返回是否成功 */
  async function genScript(projectId) {
    if (scriptBusy) return false; // 防双击并发（两次 LLM 调用 + 两条重复版本）
    scriptBusy = true;
    await renderProject(projectId);
    let stopHints = null;
    try {
      stopHints = stageHints(['#wsCopySections .ws-loading-text'], STAGES_SCRIPT);
      const { project, texts } = await api(`/api/projects/${projectId}`);
      const hasOld = SCRIPT_FIELDS.some(([k]) => (texts || []).some((t) => t.kind === k));
      const r = await api('/api/llm/script', {
        method: 'POST',
        body: {
          idea: project.idea, style: project.style,
          aspect_ratio: project.aspect_ratio, seconds: project.seconds,
          project_id: projectId, auto_select: !hasOld,
        },
      });
      if (!r.parsed) {
        toast('模型未按结构化输出（原始内容已返回供手动采用）', 'warn');
        return false;
      }
      if (!hasOld) {
        toast('文案生成完成', 'ok');
        return true;
      }
      // 新旧对比：采用新版 = 逐字段选中新生成的版本；保留 = 旧版本不受影响
      const newMap = {};
      const oldMap = {};
      for (const [k] of SCRIPT_FIELDS) {
        newMap[k] = r.result?.[k] || '';
        oldMap[k] = r.previous?.[k]?.content || '';
      }
      const renderSide = (map) => SCRIPT_FIELDS
        .map(([k, label]) => `<div class="cmp-field"><b>${esc(label)}</b><p>${esc(map[k] || '（无）')}</p></div>`)
        .join('');
      window.__ui.compare({
        title: '新生成文案与当前文案对比',
        oldLabel: '当前使用中',
        newLabel: '新生成',
        oldText: oldMap,
        newText: newMap,
        renderText: renderSide,
        onAdopt: async () => {
          try {
            for (const [k] of SCRIPT_FIELDS) {
              const tid = r.new_text_ids?.[k];
              if (tid) await api(`/api/projects/${projectId}/select-text`, { method: 'POST', body: { text_id: tid } });
            }
            toast('已采用新生成的文案', 'ok');
          } catch (e) { toast(e.message, 'err'); }
          if (currentProjectId === projectId) await renderProject(projectId);
        },
        onKeep: async () => {
          toast('已保留当前文案（新版本已存入历史，可随时选用）', 'ok');
          if (currentProjectId === projectId) await renderProject(projectId);
        },
      });
      return true;
    } catch (e) {
      toast('文案生成失败：' + e.message, 'err');
      return false;
    } finally {
      scriptBusy = false;
      stopHints?.();
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
    let stopHints = null;
    try {
      stopHints = stageHints(['#wsCharSection .ws-loading-text'], STAGES_IMG);
      const r = await api('/api/images/generate', {
        method: 'POST',
        body: {
          prompt: `角色立绘：${desc}。全身或半身构图，干净背景，正面站立，电影级写实，高细节`,
          size: $('#wsImgSize').value,
          ratio: $('#wsImgRatio').value,
          count: Number($('#wsImgCount')?.value) || 1,
          project_id: projectId,
          kind: 'character',
        },
      });
      const n = r.results?.length ?? 1;
      toast(`已生成 ${n} 张候选图${r.failed ? `（${r.failed} 张失败）` : ''}，点击图片定稿种子图`, 'ok');
    } catch (e) {
      toast('图片生成失败：' + e.message, 'err');
    } finally {
      imgGenBusy = false;
      stopHints?.();
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