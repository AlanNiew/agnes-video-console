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
  const KIND_ORDER = ['video_prompt', 'script', 'character_desc', 'scene_desc'];

  let currentProjectId = null;
  let imgGenBusy = false;
  let scriptBusy = false;

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
    $('#wsNewProject').onclick = () => openNewProject();
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

  function openNewProject() {
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
              <select id="npAspect"><option value="16:9" selected>16:9 横屏</option><option value="9:16">9:16 竖屏</option><option value="1:1">1:1 方形</option><option value="4:3">4:3</option><option value="3:4">3:4</option><option value="21:9">21:9 超宽</option></select>
            </div>
            <div class="field"><label>目标时长</label>
              <select id="npSeconds"><option value="5" selected>5 秒</option><option value="8">8 秒</option><option value="10">10 秒</option><option value="4">4 秒</option><option value="6">6 秒</option><option value="7">7 秒</option><option value="9">9 秒</option><option value="11">11 秒</option><option value="12">12 秒</option></select>
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

  /* ---------------- 项目详情 ---------------- */
  async function renderProject(id) {
    const d = await api(`/api/projects/${id}`);
    const p = d.project;
    const texts = d.texts || [];
    const images = d.images || [];
    const tasks = d.tasks || [];
    const selVideo = (t) => t.find((x) => x.kind === 'video_prompt' && x.selected) || t.find((x) => x.kind === 'video_prompt');
    const selChar = images.find((x) => x.kind === 'character' && x.selected) || images.find((x) => x.kind === 'character');
    const selVideoText = selVideo(texts);
    const stepsDone = {
      1: Boolean(p.idea),
      2: texts.some((t) => t.kind === 'video_prompt'),
      3: Boolean(selChar),
      4: p.status === 'video_submitted' || tasks.length > 0,
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

        <!-- ② 文案 -->
        <div class="copy-sect">
          <h4>📝 文案与提示词 <span class="badge-selected" hidden id="wsCopyDone">已生成</span></h4>
          ${scriptBusy ? '<div class="ws-loading"><span class="spinner"></span> 文本模型正在创作文案…</div>' : `
          <button class="btn primary sm" id="wsGenScript">✨ 生成 / 重新生成文案</button>
          <div class="hint mt">梗概、视频提示词、角色描述一次生成；每项可手动编辑保存、可选用历史版本。</div>`}
          <div id="wsCopySections" class="mt">${renderTextSections(texts)}</div>
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
                <select id="wsImgRatio"><option value="1:1" selected>1:1</option><option value="3:4">3:4</option><option value="4:3">4:3</option><option value="16:9">16:9</option><option value="9:16">9:16</option></select>
                <select id="wsImgSize"><option value="1K" selected>1K</option><option value="2K">2K</option><option value="3K">3K</option><option value="4K">4K</option></select>
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
                <b>分镜提示词：</b>${esc(selVideoText?.content || '（请先完成文案步骤）')}
              </div>
            </div>
            <div class="row mt" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <select id="wsVSeconds" class="meta-tag" title="视频时长" style="background:var(--bg)">
                ${[4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => `<option value="${s}" ${String(s) === String(p.seconds || 5) ? 'selected' : ''}>${s} 秒</option>`).join('')}
              </select>
              <select id="wsVAspect" class="meta-tag" style="background:var(--bg)">
                ${['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((a) => `<option ${a === (p.aspect_ratio || '16:9') ? 'selected' : ''}>${a}</option>`).join('')}
              </select>
              <span class="meta-tag">2.5-flash（免费 · 720P）</span>
              <span class="spacer" style="flex:1"></span>
              <button class="btn primary" id="wsSubmitVideo" ${selChar && selVideoText ? '' : 'disabled'}>🚀 提交视频任务</button>
            </div>
            <div class="hint mt">将用：定稿角色图 + 分镜提示词（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」）</div>
          </div>
          ${tasks.length ? `
          <div class="mt"><b>本项目视频任务：</b></div>
          <div class="ver-list mt">${tasks.map((t) => `
            <div class="ver-item">
              #${t.id} · ${STATUS_LABEL[t.status] || t.status} · ${t.progress != null ? t.progress + '%' : ''} · ${fmtTime(t.created_at)}
              ${t.status === 'completed' && t.metadata_url ? `<a class="act green" href="${esc(t.metadata_url)}" target="_blank" rel="noopener">播放/下载</a>` : ''}
              <a class="act" href="#" data-goto-task="${t.id}" style="margin-left:auto">去任务中心查看</a>
            </div>`).join('')}
          </div>` : ''}
        </div>
      </div>`;

    $('#wsBack').onclick = () => { currentProjectId = null; renderList(); };
    $('#wsDel').onclick = async () => {
      if (!confirm(`确认删除项目「${p.name}」？文案与角色图将一并删除，视频任务保留。`)) return;
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      toast('项目已删除', 'ok');
      currentProjectId = null;
      renderList();
    };
    if (!scriptBusy) $('#wsGenScript').onclick = () => genScript(p.id);
    $('#wsGenChar').onclick = () => genCharacterImage(p.id);
    $('#wsSubmitVideo').onclick = () => submitVideo(p.id);
    bindTextSectionEvents(p.id);
    bindWallEvents(p.id);
    $('#wsDel').onclick = async () => {
      if (!confirm(`确认删除项目「${p.name}」？`)) return;
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      currentProjectId = null;
      await renderList();
    };
    // 跳转任务中心
    ws.querySelectorAll('[data-goto-task]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        $('#navTasks')?.click();
        const card = document.querySelector(`.card[data-id="${a.dataset.gotoTask}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
    );
  }

  /* 文案分区渲染 */
  function renderTextSections(texts) {
    const byKind = {};
    for (const t of texts) (byKind[t.kind] = byKind[t.kind] || []).push(t);
    return KIND_ORDER.map((kind) => {
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
    const p = await api(`/api/projects/${projectId}`);
    scriptBusy = true;
    await renderProject(projectId);
    try {
      const r = await api('/api/llm/script', {
        method: 'POST',
        body: { idea: p.project.idea, style: p.project.style, aspect_ratio: p.project.aspect_ratio, seconds: p.project.seconds, project_id: projectId },
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
      await renderProject(projectId);
    }
  }

  async function genCharacterImage(projectId) {
    const desc = $('#wsCharDesc').value.trim();
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
      await renderProject(projectId);
    }
  }

  async function submitVideo(projectId) {
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
    }
  }

  // 暴露给 app.js 的视图切换使用
  window.__ws = { refresh };
})();