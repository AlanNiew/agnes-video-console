/* ws-render-panel.js —— 创作工作台第⑦步：成片渲染面板事件绑定（M4-B3-7：自 workspace.js 拆出）
 * 渲染按钮提交 / 成片风格预设套用 / 高级配置「实时配方」说明 / 渲染任务轮询。
 * 「局部更新」：提交与轮询只增改 #wsRenderJobs 子树并显示产物，不再整页重绘——
 * 保留其它步骤未保存输入与面板上已调配置；轮询全部落定即停。
 * 依赖：common.js、ws-state.js（st）、ws-render.js（FILM_PRESETS/TRANSITION_LABELS/
 * SUBSTYLE_LABELS 为纯常量，renderJobItem 渲染任务行）。
 */
import { $, esc, fmtTime, toast, api, openModal } from './common.js';
import { st } from './ws-state.js';
import { FILM_PRESETS, TRANSITION_LABELS, SUBSTYLE_LABELS, renderJobItem } from './ws-render.js';

let renderPollTimer = null;

/** 渲染任务进行中：每 2s 拉 jobs 局部刷新 #wsRenderJobs；全部落定即停（产物随 job 行展示，无需整页重绘） */
function startRenderPoll(projectId) {
  clearInterval(renderPollTimer);
  renderPollTimer = setInterval(async () => {
    if (st.currentProjectId !== projectId) {
      clearInterval(renderPollTimer);
      renderPollTimer = null;
      return;
    }
    let jobs;
    try {
      const r = await api(`/api/projects/${projectId}/render/jobs`);
      jobs = (r && r.items) || [];
    } catch {
      return;
    }
    const box = $('#wsRenderJobs');
    if (box) box.innerHTML = jobs.map(renderJobItem).join('');
    if (!jobs.some((j) => j.status === 'queued' || j.status === 'rendering')) {
      clearInterval(renderPollTimer);
      renderPollTimer = null;
    }
  }, 2000);
}

/** 提交一次成片渲染（读面板当前配置）。返回 job；渲染按钮与「配音并重渲」快捷链路共用。 */
async function submitRender(projectId) {
  const job = await api(`/api/projects/${projectId}/render`, {
    method: 'POST',
    body: {
      transition_ms: Number($('#wsRTransition')?.value || 600),
      transition_type: $('#wsRTransitionType')?.value || 'fade',
      narration_offset_ms: Number($('#wsRNarrOffset')?.value || 500),
      title_card: $('#wsRTitle')?.checked !== false,
      end_card: $('#wsREnd')?.checked !== false,
      bgm_volume: Number($('#wsRBgmVol')?.value || 35) / 100,
      bgm_duck: $('#wsRDuck')?.checked !== false,
      narration_volume: Number($('#wsRNarrVol')?.value || 140) / 100,
      burn_subtitles: $('#wsRSubs')?.checked !== false,
      subtitle_fontsize: Number($('#wsRSubSize')?.value || 42),
      subtitle_style: $('#wsRSubStyle')?.value || 'white-outline',
      subtitle_position: $('#wsRSubPos')?.value || 'bottom',
      aspect: $('#wsRAspect')?.value || '16:9',
    },
  });
  // 局部更新：新任务行插入列表顶部并启动轮询（不整页重绘，保留面板已调配置）
  const box = $('#wsRenderJobs');
  if (box && job) box.insertAdjacentHTML('afterbegin', renderJobItem(job));
  startRenderPoll(projectId);
  return job;
}

/** P2-6：同项目多版成片并排对比（可选同步播放，便于发现剪辑/配音/时长差异） */
async function openRenderCompare(projectId) {
  let jobs;
  try {
    const r = await api(`/api/projects/${projectId}/render/jobs`);
    jobs = ((r && r.items) || []).filter((j) => j.status === 'completed' && j.output_url);
  } catch (e) {
    toast('加载渲染版本失败：' + e.message, 'err');
    return;
  }
  if (jobs.length < 2) {
    toast('至少需要 2 版已完成成片才能对比', 'warn');
    return;
  }
  const filmCard = (j, i) => {
    const q = j.quality || {};
    const lbl = i === 0 ? '最新' : `v${jobs.length - i}`;
    return `<div class="cmp-film" data-job="${j.id}">
        <div class="cmp-film-head"><b>${esc(lbl)}</b> · 渲染 #${j.id} · ${esc(fmtTime(j.created_at))}
          ${q.duration_s != null ? `<span class="meta-tag">${q.duration_s}s</span>` : ''}
          ${q.loudness_lufs != null ? `<span class="meta-tag">${q.loudness_lufs} LUFS</span>` : ''}
          ${q.duration_deviation_pct != null ? `<span class="meta-tag">偏差 ${q.duration_deviation_pct > 0 ? '+' : ''}${q.duration_deviation_pct}%</span>` : ''}
        </div>
        <video controls preload="metadata" src="${esc(j.output_url)}"></video>
        <div style="margin-top:6px"><a class="btn ghost sm" href="${esc(j.output_url)}" download>⬇️ 下载该版</a></div>
      </div>`;
  };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
      <div class="modal wide">
        <div class="modal-head"><h2>⚖️ 多版本成片对比（${jobs.length} 版）</h2><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:10px">最新版在左。点「▶ 同步播放」让各版从同一时刻并排播放，便于比对剪辑节奏、配音与时长差异。</div>
          <div class="cmp-films">${jobs.map(filmCard).join('')}</div>
        </div>
        <div class="modal-foot">
          <button class="btn primary sm" id="cmpSyncPlay">▶ 同步播放</button>
          <button class="btn ghost sm" id="cmpPauseAll">⏸ 全部暂停</button>
          <span style="flex:1"></span>
          <button class="btn ghost" id="cmpClose">关闭</button>
        </div>
      </div>`;
  document.body.appendChild(overlay);
  const vids = () => [...overlay.querySelectorAll('.cmp-films video')];
  let syncTimer = null;
  const close = () => {
    clearInterval(syncTimer);
    syncTimer = null;
    overlay.remove();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.modal-close') || e.target.closest('#cmpClose')) close();
  });
  overlay.querySelector('#cmpSyncPlay').onclick = () => {
    const vs = vids();
    if (!vs.length) return;
    vs.forEach((v) => {
      v.currentTime = 0;
      v.play().catch(() => {});
    });
    clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      const t = vs[0].currentTime;
      vs.slice(1).forEach((v) => {
        if (Math.abs(v.currentTime - t) > 0.4) v.currentTime = t;
      });
    }, 400);
  };
  overlay.querySelector('#cmpPauseAll').onclick = () => {
    clearInterval(syncTimer);
    syncTimer = null;
    vids().forEach((v) => v.pause());
  };
}

/** P2-7 / v2.5：把当前项目参数（创意/风格/画幅/时长 + 成片预设 + 角色库角色）存成可复用系列模板 */
async function saveProjectTemplate(projectId) {
  let p;
  let imgs = [];
  try {
    const d = await api(`/api/projects/${projectId}`);
    p = d.project;
    imgs = d.images || [];
  } catch (e) {
    toast('读取项目失败：' + e.message, 'err');
    return;
  }
  const name = prompt('模板名称（创意 + 风格 + 画幅/时长 + 成片预设 + 角色）', p.name || '');
  if (!name || !name.trim()) return;
  // v2.5：定稿角色图若能按 remote_url 命中角色库，则模板自动携带其 character_ids（新建项目时自动导入）
  let character_ids = [];
  try {
    const lib = (await api('/api/characters')).items || [];
    const selUrls = new Set(
      imgs.filter((x) => x.kind === 'character' && x.selected && x.remote_url).map((x) => x.remote_url),
    );
    character_ids = lib.filter((c) => selUrls.has(c.remote_url)).map((c) => c.id);
  } catch {
    /* 角色库不可用时忽略 */
  }
  try {
    await api('/api/templates', {
      method: 'POST',
      body: {
        name: name.trim(),
        idea: p.idea || '',
        style: p.style || '',
        aspect_ratio: p.aspect_ratio,
        seconds: p.seconds,
        film_preset: st.wsFilmPresetId || '',
        character_ids,
        naming: p.name || '', // 命名规范：以本项目名作系列命名的起点
      },
    });
    toast(
      `已存为创作模板${character_ids.length ? `（含 ${character_ids.length} 个角色）` : ''}，新建项目可一键套用`,
      'ok',
    );
  } catch (e) {
    toast('保存模板失败：' + e.message, 'err');
  }
}

/** v2.5 渲染质检弹窗：关键帧 4 张 + 音频波形 + 音视频流时长对比 + 客观指标（亮度/闪烁/运动） */
async function inspectRender(jobId) {
  let r;
  try {
    r = await api(`/api/render/jobs/${jobId}/inspect`);
  } catch (e) {
    return toast('质检失败：' + e.message, 'err');
  }
  const m = r.metrics || {};
  const bodyHTML = `
    <div class="hint">时长 ${r.duration_s}s · 视频流 ${r.video_stream_s ?? '?'}s · 音频流 ${r.audio_stream_s ?? '?'}s · 差 ${r.audio_gap_s ?? '?'}s</div>
    ${(r.hints || []).map((h) => `<span class="meta-tag" style="display:inline-block;margin:6px 6px 0 0">${esc(h)}</span>`).join('')}
    <div class="mt" style="display:flex;gap:8px;flex-wrap:wrap">
      ${(r.frames || [])
        .map(
          (f) =>
            `<a href="${esc(f.url)}" target="_blank" title="${f.at_s}s 处"><img src="${esc(f.url)}" style="width:31%;border-radius:6px;border:1px solid #333" /></a>`,
        )
        .join('')}
    </div>
    ${r.wave ? `<div class="mt"><div class="hint">音频波形（整片；开头有孤立尖刺 = 爆音，尾部平坦 = 静音）</div><img src="${esc(r.wave)}" style="width:100%;border-radius:6px" /></div>` : ''}
    <div class="mt hint">客观指标：亮度均值 ${m.luma_mean ?? '?'} · 亮度波动 ${m.luma_std ?? '?'} · 闪烁帧占比 ${m.flash_ratio ?? '?'} · 运动幅度 ${m.motion_mean ?? '?'}（采样 ${m.sampled_frames ?? '?'} 帧）</div>`;
  openModal({ title: `🔍 渲染 #${jobId} 质检`, bodyHTML });
}

/** v2.5 制作矩阵（P1-2）：镜 × (视频 / 配音 / 时长校验 / 角色引用 / 定稿 take) 一屏就绪度 */
async function showMatrix(projectId) {
  let d;
  try {
    d = await api(`/api/projects/${projectId}`);
  } catch (e) {
    return toast('读取项目失败：' + e.message, 'err');
  }
  const { shots = [], tasks = [], tts = [] } = d;
  const latestTask = (sid) =>
    tasks.filter((t) => t.shot_id === sid && t.status === 'completed').sort((a, b) => b.id - a.id)[0];
  const latestTts = (sid) =>
    tts
      .filter((t) => t.kind === 'shot' && t.shot_id === sid && t.local_path && !t.error_message)
      .sort((a, b) => b.id - a.id)[0];
  const rows = shots
    .map((s) => {
      const t = latestTask(s.id);
      const v = latestTts(s.id);
      const sec = Number(s.seconds || d.project?.seconds || 5);
      const off = (v?.offset_ms != null ? v.offset_ms : 500) / 1000;
      const timingOk = !v?.duration ? null : v.duration + off <= sec * 1.03;
      const refs =
        s.use_character_ref === 0
          ? '空镜'
          : Array.isArray(s.ref_image_ids) && s.ref_image_ids.length
            ? s.ref_image_ids.map((x) => '#' + x).join('/')
            : '全部';
      const mark = (ok) => (ok === null ? '—' : ok ? '✅' : '❌');
      return `<tr>
        <td>${s.seq}</td>
        <td>${esc((s.title || '').slice(0, 12))}</td>
        <td>${sec}s</td>
        <td>${mark(!!t)}${t ? ' #' + t.id : ''}</td>
        <td>${mark(!!v)}${v && v.duration ? ' ' + v.duration + 's' : ''}</td>
        <td>${mark(timingOk)}${timingOk === false ? ' 超长' : ''}</td>
        <td>${esc(refs)}</td>
        <td>${s.take_task_id ? '#' + s.take_task_id : '自动'}</td>
        <td><button class="btn ghost sm" data-final-prompt="${s.id}" title="查看实际会发给上游的提示词（含自动注入的风格锚/角色前缀）">📋</button></td>
      </tr>`;
    })
    .join('');
  const bodyHTML = `
    <div style="max-height:60vh;overflow:auto">
      <table class="matrix-table">
        <thead><tr><th>#</th><th>标题</th><th>秒</th><th>视频</th><th>配音</th><th>时长校验</th><th>角色引用</th><th>定稿 take</th><th>提词</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint mt">「时长校验」= 配音时长 + 偏移 ≤ 镜头时长 ×1.03（❌ 会被渲染截断）；角色引用「全部」= 引用项目全部定稿角色图；「📋 提词」= 实际提交文本（含自动补的风格锚与角色前缀）。</p>`;
  openModal({
    title: `📊 制作矩阵（${shots.length} 镜）`,
    bodyHTML,
    onMount: (overlay) => {
      // v2.5.1：查看"库里的提示词 ≠ 实际发出的提示词"——风格漂移的排查入口
      overlay.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-final-prompt]');
        if (!btn) return;
        const sid = Number(btn.dataset.finalPrompt);
        try {
          const fp = await api(`/api/projects/${projectId}/shots/${sid}/final-prompt`);
          const head =
            fp.warnings && fp.warnings.length
              ? `<div class="hint mb" style="color:#e0b050">${fp.warnings.map((w) => '⚠️ ' + esc(w)).join('<br>')}</div>`
              : '<div class="hint mb">✅ 库内提示词已含风格锚与角色前缀</div>';
          const meta = `<div class="hint mb">模式：${esc(fp.mode)}${fp.blocked_reason ? '（' + esc(fp.blocked_reason) + '）' : ''}${
            fp.refs && fp.refs.length
              ? ` · 参考图 ${fp.refs.length} 张（${fp.refs.map((r) => '#' + r.id).join(' ')}）`
              : ''
          }</div>`;
          openModal({
            title: `📋 镜 ${sid} 实际提交提示词`,
            bodyHTML:
              head +
              meta +
              `<pre style="white-space:pre-wrap;word-break:break-word;background:var(--bg,#161b26);padding:10px;border-radius:6px;max-height:50vh;overflow:auto">${esc(fp.prompt || '')}</pre>`,
          });
        } catch (err) {
          toast('读取失败：' + err.message, 'err');
        }
      });
    },
  });
}

/** v2.5.2 交付自检（checklist API 的前端呈现）：9 项就绪度一屏，全绿再渲染归档 */
async function showChecklist(projectId) {
  let ck;
  try {
    ck = await api(`/api/projects/${projectId}/checklist`);
  } catch (e) {
    return toast('读取自检失败：' + e.message, 'err');
  }
  const rows = (ck.items || [])
    .map(
      (it) =>
        `<tr><td>${it.ok ? '✅' : '❌'}</td><td>${esc(it.label || '')}</td><td class="hint">${esc(it.detail || '')}</td></tr>`,
    )
    .join('');
  openModal({
    title: `✅ 交付自检（${ck.ready}/${ck.total} · ${ck.ready_pct}%）`,
    bodyHTML: `<table class="matrix-table"><thead><tr><th style="width:36px"></th><th>检查项</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="hint mt">全绿后再渲染归档；缺项可在上方步骤中补齐（分镜/配音/BGM 等）。</p>`,
  });
}

/** 第⑦步成片渲染面板绑定。renderJobs 用于进入时判断是否已在渲染中（需续轮询）。 */
function bindRenderPanel(projectId, renderJobs = []) {
  // v2.5：渲染质检图与指标（关键帧 / 波形 / 流时长对比 / 客观指标）
  document.querySelectorAll('[data-inspect-render]').forEach((b) => {
    b.onclick = () => inspectRender(Number(b.dataset.inspectRender));
  });
  const rbtn = $('#wsRenderBtn');
  const mbtn = $('#wsMatrix');
  if (mbtn) mbtn.onclick = () => showMatrix(projectId); // v2.5 制作矩阵（P1-2）
  const cbtn = $('#wsChecklist');
  if (cbtn) cbtn.onclick = () => showChecklist(projectId); // v2.5.2 交付自检（S-3 前端呈现）
  if (rbtn) {
    rbtn.onclick = async () => {
      rbtn.disabled = true;
      try {
        await submitRender(projectId);
        toast('渲染任务已创建，后台合成中（可离开本页）', 'ok');
      } catch (e) {
        toast('渲染失败：' + e.message, 'err');
      } finally {
        if (rbtn.isConnected) rbtn.disabled = false;
      }
    };
  }
  // P2-6：多版本对比（点开时拉取已完成成片，≥2 版才可对比）
  const cmpBtn = $('#wsRenderCompare');
  if (cmpBtn) cmpBtn.onclick = () => openRenderCompare(projectId);
  // P2-7：存为创作模板（成功案例参数模板化）
  const saveTplBtn = $('#wsSaveTemplate');
  if (saveTplBtn) saveTplBtn.onclick = () => saveProjectTemplate(projectId);
  // P2：风格预设交互 —— 点击卡片套用整套配方；手动改高级配置即切换为「自定义配方」
  const filmRecipeEl = $('#wsFilmRecipe');
  const renderRecipe = () => {
    if (!filmRecipeEl) return;
    if (st.wsFilmPresetId) {
      const preset = FILM_PRESETS.find((x) => x.id === st.wsFilmPresetId);
      if (preset) {
        filmRecipeEl.innerHTML = `🎬 当前配方：<b>${preset.emoji} ${esc(preset.label)}</b> —— ${esc(preset.desc)}`;
        return;
      }
    }
    filmRecipeEl.innerHTML = `🎬 当前配方：<b>自定义</b> —— ${esc(TRANSITION_LABELS[$('#wsRTransitionType')?.value] || '淡入淡出')}转场 ${((Number($('#wsRTransition')?.value) || 600) / 1000).toFixed(1)}s · ${esc(SUBSTYLE_LABELS[$('#wsRSubStyle')?.value] || '白字描边')}字幕 · BGM ${$('#wsRBgmVol')?.value || 35}%`;
  };
  const updateRenderRangeLabels = () => {
    const pairs = [
      ['#wsRTransition', '#wsRTransitionV', (v) => (Number(v) / 1000).toFixed(1) + 's'],
      ['#wsRSubSize', '#wsRSubSizeV', (v) => String(v)],
      ['#wsRBgmVol', '#wsRBgmVolV', (v) => v + '%'],
      ['#wsRNarrVol', '#wsRNarrVolV', (v) => v + '%'],
      ['#wsRNarrOffset', '#wsRNarrOffsetV', (v) => (Number(v) / 1000).toFixed(1) + 's'],
    ];
    for (const [sel, labelSel, fmt] of pairs) {
      const el = $(sel);
      const lbl = $(labelSel);
      if (el && lbl) lbl.textContent = fmt(el.value);
    }
  };
  document.querySelectorAll('#wsFilmPresets .film-preset').forEach((b) => {
    b.addEventListener('click', () => {
      st.wsFilmPresetId = b.dataset.preset;
      document.querySelectorAll('#wsFilmPresets .film-preset').forEach((x) => x.classList.toggle('active', x === b));
      const preset = FILM_PRESETS.find((x) => x.id === st.wsFilmPresetId);
      const pa = preset?.params || {};
      const setVal = (sel, v) => {
        const el = $(sel);
        if (el && v !== undefined) el.value = v;
      };
      setVal('#wsRTransition', pa.transition_ms);
      setVal('#wsRTransitionType', pa.transition_type);
      setVal('#wsRSubStyle', pa.subtitle_style);
      setVal('#wsRSubPos', pa.subtitle_position);
      setVal('#wsRSubSize', pa.subtitle_fontsize);
      setVal('#wsRBgmVol', Math.round((pa.bgm_volume ?? 0.35) * 100));
      setVal('#wsRNarrVol', Math.round((pa.narration_volume ?? 1.4) * 100));
      setVal('#wsRNarrOffset', pa.narration_offset_ms);
      if (pa.bgm_duck !== undefined && $('#wsRDuck')) $('#wsRDuck').checked = pa.bgm_duck;
      updateRenderRangeLabels();
      renderRecipe();
    });
  });
  const advConfig = $('#wsAdvConfig');
  if (advConfig) {
    advConfig.addEventListener('change', () => {
      // 手动调整任何参数 → 脱离预设（配方说明切为自定义）
      st.wsFilmPresetId = '';
      document.querySelectorAll('#wsFilmPresets .film-preset').forEach((x) => x.classList.remove('active'));
      renderRecipe();
    });
    advConfig.addEventListener('input', updateRenderRangeLabels);
  }
  renderRecipe();
  if (renderJobs.some((j) => j.status === 'queued' || j.status === 'rendering')) startRenderPoll(projectId);
}

export { bindRenderPanel, submitRender };
