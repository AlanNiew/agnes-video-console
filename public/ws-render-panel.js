/* ws-render-panel.js —— 创作工作台第⑦步：成片渲染面板事件绑定（M4-B3-7：自 workspace.js 拆出）
 * 渲染按钮提交 / 成片风格预设套用 / 高级配置「实时配方」说明 / 渲染任务轮询。
 * 「局部更新」：提交与轮询只增改 #wsRenderJobs 子树并显示产物，不再整页重绘——
 * 保留其它步骤未保存输入与面板上已调配置；轮询全部落定即停。
 * 依赖：common.js、ws-state.js（st）、ws-render.js（FILM_PRESETS/TRANSITION_LABELS/
 * SUBSTYLE_LABELS 为纯常量，renderJobItem 渲染任务行）。
 */
import { $, esc, toast, api } from './common.js';
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
      jobs = (r && r.data && r.data.items) || [];
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

/** 第⑦步成片渲染面板绑定。renderJobs 用于进入时判断是否已在渲染中（需续轮询）。 */
function bindRenderPanel(projectId, renderJobs = []) {
  const rbtn = $('#wsRenderBtn');
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
