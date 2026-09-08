/* ws-tts.js —— 创作工作台第⑤步：配音（Fish TTS）+ 声音广场（M4-B3-2：自 workspace.js 拆出）
 * 含：TTS 动作（自由文稿/逐镜/批量配音、绑定/选用/删除/试听）、备选池与声音广场浏览。
 * 动作完成后的「整页重刷」不再直接调用 renderProject（避免与装配模块循环依赖），
 * 统一广播 bus 'ws-project-changed'(projectId)，由 workspace.js（装配）判断是否当前项目并重绘。
 * 依赖：common.js、state.js（bus）。
 */
import { $, esc, toast, api } from './common.js';
import { bus } from './state.js';

/* ---------------- 音色偏好缓存（bindTtsEvents 拉取设置后填充，供模板渲染默认语速） ---------------- */
let wsSettingsCache = null;
function wsDefaultSpeed() {
  return wsSettingsCache?.fish_speed ?? 1;
}
function defaultTtsText(texts, shots) {
  // v2.1 修正：只取每镜的「旁白文案」字段（shots.narration）——
  // 镜头标题与画面提示词（景别/运镜/主视角等）属于画面描述，绝不进入配音文稿。
  // 无分镜旁白时回退故事梗概。
  const lines = (shots || []).map((s) => (s.narration || '').trim()).filter(Boolean);
  if (lines.length) return lines.join('\n');
  const script = texts.find((t) => t.kind === 'script' && t.selected) || texts.find((t) => t.kind === 'script');
  return script ? script.content : '';
}

async function loadMetaVoices() {
  let voices = [];
  try {
    const r = await fetch('/api/tts/voices');
    if (r.ok) {
      const j = await r.json();
      voices = j.voices || [];
    }
  } catch {
    /* ignore */
  }
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
  } catch {
    /* ignore */
  }
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
        bus.emit('ws-project-changed', projectId);
      } catch (e) {
        toast('绑定失败：' + e.message, 'err');
      }
    });
    wall.onclick = async (ev) => {
      const playBtn = ev.target.closest('[data-tts-play]');
      if (playBtn) {
        ev.stopPropagation();
        const url = playBtn.dataset.ttsPlay;
        // 预留：未来可注入独立音频预览服务；当前一律走本地 Audio
        const au = playBtn._au || (playBtn._au = new Audio(url));
        if (au.paused && !au.ended) au.play();
        else {
          au.currentTime = 0;
          au.play();
        }
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
          bus.emit('ws-project-changed', projectId);
        } catch (e) {
          toast('选用失败：' + e.message, 'err');
        }
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
          bus.emit('ws-project-changed', projectId);
        } catch (e) {
          toast('删除失败：' + e.message, 'err');
        }
      }
    };
  }
  const fillN = $('#wsTtsFillNarration');
  if (fillN)
    fillN.onclick = async () => {
      const d = await api(`/api/projects/${projectId}`);
      const ta = $('#wsTtsText');
      if (ta) ta.value = defaultTtsText(d.texts || [], d.shots || []);
      toast('已用分镜填充旁白文稿，可再编辑', 'ok');
    };
  const fillS = $('#wsTtsFillScript');
  if (fillS)
    fillS.onclick = async () => {
      const d = await api(`/api/projects/${projectId}`);
      const s =
        (d.texts || []).find((t) => t.kind === 'script' && t.selected) ||
        (d.texts || []).find((t) => t.kind === 'script');
      const ta = $('#wsTtsText');
      if (ta && s) ta.value = s.content;
      toast('已用故事梗概填充', 'ok');
    };
  genBtn.onclick = () => genTts(projectId);
  // v2.1：为所有有旁白的镜头逐条生成配音并自动绑定
  const genShotsBtn = $('#wsTtsGenShots');
  if (genShotsBtn) genShotsBtn.onclick = () => genAllShotTts(projectId);
}

/** v2.1：单镜头配音——用该镜「旁白文案」合成并绑定 shot_id（覆盖该镜旧绑定） */
async function genShotTts(projectId, shotId, shotLabel) {
  const d = await api(`/api/projects/${projectId}`);
  const shot = (d.shots || []).find((s) => s.id === shotId);
  const text = (shot?.narration || '').trim();
  if (!text) {
    toast(`${shotLabel || '该镜头'}没有旁白文案，先在第②步填写`, 'warn');
    return false;
  }
  const voice = $('#wsTtsVoice')?.value || 'default';
  const speed = Number($('#wsTtsSpeed')?.value || 1);
  try {
    const r = await api('/api/tts/generate', {
      method: 'POST',
      body: { text, voice, speed, kind: 'shot', shot_id: shotId, project_id: projectId },
    });
    toast(`${shotLabel || '镜头'}配音已生成并绑定（${r.duration ?? '?'}s）`, 'ok');
    return true;
  } catch (e) {
    toast(`${shotLabel || '镜头'}配音失败：${e.message}`, 'err');
    return false;
  }
}

/** v2.1：批量逐镜配音——所有有旁白文案的镜头依次合成（逐个请求，失败不阻塞后续） */
async function genAllShotTts(projectId) {
  const btn = $('#wsTtsGenShots');
  const hint = $('#wsTtsShotsHint');
  const d = await api(`/api/projects/${projectId}`);
  const targets = (d.shots || []).filter((s) => (s.narration || '').trim());
  if (!targets.length) {
    toast('没有镜头填写旁白文案', 'warn');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '逐镜配音中…';
  }
  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const s = targets[i];
      if (hint) hint.textContent = `正在合成镜头 ${s.seq}/${targets.length}…`;
      const done = await genShotTts(projectId, s.id, `镜头 ${s.seq}${s.title ? `「${s.title}」` : ''}`);
      if (done) ok += 1;
      else fail += 1;
    }
    if (hint) hint.textContent = '';
    toast(`逐镜配音完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`, fail ? 'warn' : 'ok');
    bus.emit('ws-project-changed', projectId);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🎙️ 为所有镜头生成配音';
    }
  }
}

async function genTts(projectId) {
  const ta = $('#wsTtsText');
  const text = ta ? ta.value.trim() : '';
  if (!text) {
    toast('请先输入配音文稿', 'err');
    return;
  }
  const voice = $('#wsTtsVoice')?.value || 'default';
  const speed = Number($('#wsTtsSpeed')?.value || 1);
  const genBtn = $('#wsTtsGen');
  const hint = $('#wsTtsHint');
  if (genBtn) {
    genBtn.disabled = true;
    genBtn.textContent = '生成中…';
  }
  if (hint) hint.textContent = '正在合成，可能需要 10–60 秒…';
  try {
    const r = await api('/api/tts/generate', {
      method: 'POST',
      body: { text, voice, speed, kind: 'narration', project_id: projectId },
    });
    toast(`配音已生成（${r.duration ?? '?'}s · ${r.voice_title || ''}）`, 'ok');
    bus.emit('ws-project-changed', projectId);
  } catch (e) {
    toast('配音生成失败：' + e.message, 'err');
    if (hint) hint.textContent = '';
  } finally {
    if (genBtn) {
      genBtn.disabled = false;
      genBtn.textContent = '🗣️ 合成自由文稿';
    }
  }
}

/* ---------------- 声音广场（音色备选池 + 浏览 / 试听 / 入池） ---------------- */
async function refreshVoicePool() {
  const box = $('#wsMkPool');
  if (!box) return;
  try {
    const r = await api('/api/tts/pool');
    const items = r.items || [];
    box.innerHTML = items.length
      ? `<span class="hint">⭐ 备选池（${items.length}）：</span>` +
        items
          .map(
            (v) => `
          <span class="meta-tag" style="border-color:#2b8a5a;color:#2b8a5a">⭐ ${esc(v.title)}${v.author ? ' · ' + esc(v.author) : ''}</span>
          <button class="btn ghost sm" data-pool-del="${esc(v.id)}" title="移出备选池">✕</button>`,
          )
          .join(' ')
      : '<span class="hint">备选池为空——从下方声音广场收录喜欢的音色。</span>';
    box.querySelectorAll('[data-pool-del]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/tts/pool/${b.dataset.poolDel}`, { method: 'DELETE' });
          toast('已移出备选池', 'ok');
          await refreshVoicePool();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
  } catch {
    box.innerHTML = '<span class="hint">备选池加载失败</span>';
  }
}

function bindVoiceMarket(projectId) {
  refreshVoicePool();
  let mkAudio = null;
  let mkUrl = '';
  const searchBtn = $('#wsMkSearch');
  if (searchBtn) {
    searchBtn.onclick = async () => {
      searchBtn.disabled = true;
      try {
        const tags = [$('#wsMkGender')?.value, $('#wsMkAge')?.value]
          .filter(Boolean)
          .map((t) => '&tag=' + encodeURIComponent(t))
          .join('');
        const r = await api(
          `/api/tts/market?sort_by=${$('#wsMkSort')?.value || 'trending'}&page_size=12&language=zh${tags}`,
        );
        const box = $('#wsMkResults');
        const items = r.items || [];
        box.innerHTML = items.length
          ? items
              .map(
                (m) => `
            <div class="ver-item" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span><b>${esc(m.title)}</b> <span class="muted">${esc(m.author || '')}</span></span>
              ${m.like_count ? `<span class="meta-tag" title="点赞数">♥${m.like_count}</span>` : ''}
              ${m.task_count ? `<span class="meta-tag" title="被使用次数">▶${m.task_count}</span>` : ''}
              <span class="hint" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((m.tags || []).slice(0, 4).join(' · '))}</span>
              <span class="spacer" style="flex:1"></span>
              ${m.sample ? `<button class="btn ghost sm" data-mk-play="${esc(m.sample)}">▶ 试听</button>` : ''}
              <button class="btn ghost sm" ${m.in_pool ? 'disabled' : ''} data-mk-add="${esc(m.id)}" data-title="${esc(m.title)}" data-author="${esc(m.author || '')}" data-likes="${m.like_count || 0}" data-tasks="${m.task_count || 0}" data-tags="${esc((m.tags || []).join(','))}">${m.in_pool ? '✓ 已在池' : '＋备选'}</button>
            </div>`,
              )
              .join('')
          : '<span class="hint">没有找到结果</span>';
        box.querySelectorAll('[data-mk-play]').forEach((b) => {
          b.onclick = () => {
            if (!mkAudio) mkAudio = new Audio();
            const url = b.dataset.mkPlay;
            if (mkUrl === url) {
              mkAudio.paused ? mkAudio.play().catch(() => {}) : mkAudio.pause();
              return;
            }
            mkUrl = url;
            mkAudio.src = url;
            mkAudio.play().catch(() => toast('试听加载失败', 'err'));
          };
        });
        box.querySelectorAll('[data-mk-add]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            try {
              await api('/api/tts/pool', {
                method: 'POST',
                body: {
                  id: b.dataset.mkAdd,
                  title: b.dataset.title,
                  author: b.dataset.author,
                  like_count: Number(b.dataset.likes) || 0,
                  task_count: Number(b.dataset.tasks) || 0,
                  tags: (b.dataset.tags || '').split(',').filter(Boolean),
                },
              });
              toast('已加入备选池，可在「默认音色」下拉中选用', 'ok');
              await refreshVoicePool();
              const inPool = box.querySelector(`[data-mk-add="${b.dataset.mkAdd}"]`);
              if (inPool) {
                inPool.disabled = true;
                inPool.textContent = '✓ 已在池';
              }
            } catch (e) {
              toast('加入失败：' + e.message, 'err');
              b.disabled = false;
            }
          };
        });
      } catch (e) {
        toast('浏览失败：' + e.message, 'err');
      } finally {
        searchBtn.disabled = false;
      }
    };
  }
}

export { bindTtsEvents, bindVoiceMarket, genShotTts, defaultTtsText, wsDefaultSpeed };
