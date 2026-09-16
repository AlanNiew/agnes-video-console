/* 创作工作台 —— 流水线 UI（创意 → 文案 → 角色设定 → 视频）—— M4-B3-7：
 * 渲染纯函数在 ws-render.js；配音/声音广场在 ws-tts.js；会话状态在 ws-state.js（st）；
 * 工具在 ws-util.js；第④步视频提交在 ws-video.js；第③步角色图在 ws-char.js；
 * 第②步文案/分镜在 ws-story.js；第⑥步 BGM 面板在 ws-bgm.js；第⑦步成片渲染面板在 ws-render-panel.js；
 * 本文件只负责装配（renderProject/renderList）与步骤导航等整体视图绑定。 */
import { $, $$, esc, toast, api } from './common.js';
import { bus } from './state.js';
import {
  STYLE_PRESETS,
  FILM_PRESETS,
  TRANSITION_LABELS,
  SUBSTYLE_LABELS,
  SUBPOS_LABELS,
  autoTimelineHTML,
  stepGuideHTML,
  stepNavHTML,
  cardHTML,
  videoModelTag,
  renderShotSubmitBlock,
  renderPrecheckHTML,
  precheckHtmlFromDetail,
  renderStoryboardArea,
  renderTextSections,
  imgCell,
  renderTaskList,
  bgmCurrentHtml,
  renderVoicePool,
  renderJobItem,
  renderTtsWall,
} from './ws-render.js';
import { bindTtsEvents, bindVoiceMarket, defaultTtsText, wsDefaultSpeed } from './ws-tts.js';
import { st } from './ws-state.js';
import { submitShot, runBatchSubmit, submitVideo } from './ws-video.js';
import { optimizeCharDesc, genCharacterImage, bindWallEvents, importFromLibrary, pickCharacters } from './ws-char.js';
import { genScript, genStoryboard, bindStoryboardEvents, bindTextSectionEvents, SCRIPT_FIELDS } from './ws-story.js';
import { bindBgmEvents } from './ws-bgm.js';
import { bindRenderPanel } from './ws-render-panel.js';

(() => {
  'use strict';

  // M4-B1-4：接收 app 的轮询/切视图信号，工作台自刷新（不再经 window.__ws 被反向调用）
  bus.on('ws-task-progress', () => {
    refreshTasks();
  });
  bus.on('workspace-shown', () => {
    refresh();
  });
  // M4-B3-2：子模块动作（配音/声音广场等）完成后广播重绘信号，装配侧判断当前项目后整页刷新
  bus.on('ws-project-changed', (pid) => {
    if (st.currentProjectId === pid) renderProject(pid);
  });

  /* ---------------- v2.2.2 草稿保护：整页重绘不丢弃用户未保存输入 ----------------
   * renderProject 每次用服务端数据重建全部 textarea/select，轮询、提交、自动成片等任一
   * 重绘都会把正在编辑却未保存的内容还原。策略：表单编辑标 dirty → 重绘前快照 → 重绘后回填。 */
  const wsView = $('#workspaceView');
  if (wsView) {
    wsView.addEventListener('input', (e) => {
      const el = e.target;
      if (!el || el.dataset.restoring) return;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT') el.dataset.dirty = '1';
    });
    wsView.addEventListener('change', (e) => {
      const el = e.target;
      if (!el || el.dataset.restoring) return;
      if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') el.dataset.dirty = '1';
    });
  }
  /** 可编辑元素的稳定身份 key（重绘前后能对上号）；返回 null 表示不值得保护 */
  function editableKeyOf(el) {
    if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT' && el.tagName !== 'SELECT')) return null;
    if (['button', 'submit', 'hidden', 'file'].includes(el.type)) return null;
    const card = el.closest('[data-shot-id]');
    if (card) {
      const role =
        (el.hasAttribute('data-shot-title') && 'title') ||
        (el.hasAttribute('data-shot-prompt') && 'prompt') ||
        (el.hasAttribute('data-shot-narration') && 'narration') ||
        (el.hasAttribute('data-shot-seconds') && 'seconds') ||
        (el.hasAttribute('data-shot-ref') && 'ref');
      if (role) return `shot:${card.dataset.shotId}:${role}`;
    }
    if (el.dataset.textId) return `text:${el.dataset.textId}`;
    if (el.id) return `id:${el.id}`;
    return null;
  }
  function captureDirtyInputs(root) {
    if (!root) return [];
    const out = [];
    for (const el of root.querySelectorAll('textarea, input, select')) {
      if (el.dataset.dirty !== '1') continue;
      const key = editableKeyOf(el);
      if (!key) continue;
      out.push({ key, type: el.type || '', tag: el.tagName, val: el.type === 'checkbox' ? el.checked : el.value });
    }
    return out;
  }
  function findEditableByKey(key) {
    const ws = $('#workspaceView');
    if (!ws) return null;
    if (key.startsWith('shot:')) {
      const parts = key.split(':');
      if (parts.length !== 3) return null;
      const card = $$('#workspaceView [data-shot-id]').find((c) => c.dataset.shotId === parts[1]);
      return card ? card.querySelector(`[data-shot-${parts[2]}]`) : null;
    }
    if (key.startsWith('text:')) return $(`[data-text-id="${key.slice(5)}"]`, ws);
    if (key.startsWith('id:')) return $('#' + key.slice(3), ws);
    return null;
  }
  function restoreDirtyInputs(pending) {
    if (!pending || !pending.length) return;
    for (const it of pending) {
      const el = findEditableByKey(it.key);
      if (!el) continue; // 结构已变（如镜头被整体重建）→ 放弃恢复，避免错位覆盖
      const same = it.type === 'checkbox' ? el.checked === it.val : el.value === it.val;
      if (!same) {
        if (it.type === 'checkbox') el.checked = it.val;
        else el.value = it.val;
        el.dataset.restoring = '1';
        try {
          el.dispatchEvent(
            new Event(it.type === 'checkbox' || it.tag === 'SELECT' ? 'change' : 'input', { bubbles: true }),
          );
        } catch {
          /* ignore */
        }
        delete el.dataset.restoring;
      }
      delete el.dataset.dirty; // 恢复后的值即新基线，避免下次重绘反复还原
    }
  }

  /* ---------------- P0：新手引导 + 步骤导航 ---------------- */
  /** 各步骤的新手说明（标题一句话 + 展开正文）；①创意由顶部引导条覆盖 */

  /* ---------------- P2：成片风格预设（一键套用整套渲染配方） ---------------- */

  /** 自动成片状态轮询：局部更新时间线，落定后整页刷新一次展示产物 */
  let autoPollTimer = null;
  let autoPollSig = '';
  function startAutoPoll(projectId) {
    clearInterval(autoPollTimer);
    autoPollSig = '';
    autoPollTimer = setInterval(async () => {
      if (st.currentProjectId !== projectId || $('#workspaceView')?.hidden) {
        clearInterval(autoPollTimer);
        autoPollTimer = null;
        return;
      }
      let st;
      try {
        const r = await api(`/api/projects/${projectId}/auto`);
        st = r.auto_state;
      } catch {
        return;
      }
      if (!st) {
        clearInterval(autoPollTimer);
        autoPollTimer = null;
        return;
      }
      const sig = JSON.stringify([st.stage, st.running, st.error, (st.history || []).length]);
      const box = $('#wsAutoTimeline');
      if (sig !== autoPollSig || !box) {
        autoPollSig = sig;
        // 局部替换时间线（不整页重绘，不打断用户查看）
        const holder = $('#wsAutoHolder');
        if (holder) {
          holder.hidden = false;
          holder.innerHTML = autoTimelineHTML(st);
          bindAutoTimelineEvents(projectId);
        }
      }
      if (!st.running) {
        clearInterval(autoPollTimer);
        autoPollTimer = null;
        if (st.currentProjectId === projectId) await renderProject(projectId); // 落定：整页刷新展示产物
      }
    }, 4000);
  }
  function bindAutoTimelineEvents(projectId) {
    const stopBtn = $('#wsAutoStop');
    if (stopBtn)
      stopBtn.onclick = async () => {
        try {
          await api(`/api/projects/${projectId}/auto/stop`, { method: 'POST' });
          toast('已停止全自动成片（已完成的部分保留）', 'warn');
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    const restartBtn = $('#wsAutoRestart');
    if (restartBtn)
      restartBtn.onclick = async () => {
        try {
          await api(`/api/projects/${projectId}/auto`, { method: 'POST' });
          toast('已重新启动全自动成片', 'ok');
          startAutoPoll(projectId);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
  }
  const guideOff = () => {
    try {
      return localStorage.getItem('wsGuideOff') === '1';
    } catch {
      return false;
    }
  };
  const setGuideOff = (off) => {
    try {
      localStorage.setItem('wsGuideOff', off ? '1' : '0');
    } catch {
      /* 隐私模式下 localStorage 不可用，忽略 */
    }
  };

  /** 滚动时步骤条高亮跟随（只绑定一次；点击跳转后短暂抑制，避免覆盖用户选择） */
  let wsScrollBound = false;
  let stepFollowUntil = 0;
  function bindStepScrollFollow() {
    if (wsScrollBound) return;
    wsScrollBound = true;
    let timer = null;
    window.addEventListener(
      'scroll',
      () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          if (!st.currentProjectId || $('#workspaceView')?.hidden) return;
          if (Date.now() < stepFollowUntil) return;
          const marks = [
            ['#wsRenderSection', 7],
            ['#wsBgmSection', 6],
            ['#wsTtsSection', 5],
            ['#wsVideoSection', 4],
            ['#wsCharSection', 3],
            ['#wsCopySections', 2],
          ];
          let cur = 1;
          const doc = document.documentElement;
          // 页面已滚到底 → 最后一步；否则取「顶部越过视口上沿 300px 内」的最近区块
          if (window.innerHeight + window.scrollY >= doc.scrollHeight - 60) {
            cur = 7;
          } else {
            for (const [sel, n] of marks) {
              const el = document.querySelector(sel);
              if (el && el.getBoundingClientRect().top <= 300) {
                cur = n;
                break;
              }
            }
          }
          st.currentStep = cur;
          document
            .querySelectorAll('.steps .step')
            .forEach((s) => s.classList.toggle('active', s.dataset.step === String(cur)));
        }, 150);
      },
      { passive: true },
    );
  }
  let META = null; // 模型/画幅/时长元数据（GET /api/meta，与任务中心同源）
  async function getMeta() {
    if (!META) META = await api('/api/meta');
    return META;
  }

  /* ---------------- 视图 ---------------- */
  async function refresh() {
    if ($('#workspaceView').hidden) return;
    try {
      if (st.currentProjectId) await renderProject(st.currentProjectId);
      else await renderList();
    } catch (e) {
      $('#workspaceView').innerHTML =
        `<div class="ws-pad"><div class="ws-loading">加载失败：${esc(e.message)}</div></div>`;
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
        ${
          items.length
            ? `<div class="ws-grid">${items.map(cardHTML).join('')}</div>`
            : `<div class="empty-box" style="margin:40px auto;max-width:480px"><h3>还没有创作项目</h3><p>一句话想法 → AI 出文案 → 生成角色设定图 → 一键发起视频任务，全部免费。</p></div>`
        }
      </div>`;
    $('#wsNewProject').onclick = () => openNewProject().catch((e) => toast('打开新建项目失败：' + e.message, 'err'));
    ws.querySelectorAll('.ws-card').forEach((c) =>
      c.addEventListener('click', () => {
        st.currentProjectId = Number(c.dataset.id);
        renderProject(st.currentProjectId);
      }),
    );
  }

  async function openNewProject() {
    const meta = await getMeta();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head"><h2>新建创作项目</h2><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="field" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <label style="margin:0">📋 套用创作模板</label>
            <select id="npTemplate" style="flex:1;min-width:150px"><option value="">（不使用模板）</option></select>
            <button type="button" class="btn ghost sm" id="npTplDel" disabled title="删除当前选中的模板">🗑 删除</button>
          </div>
          <div class="field" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn ghost sm" id="npPickChars" title="从角色库挑选本集出场角色（多角色）">📚 从角色库选角</button>
            <span class="hint" id="npPickedInfo">未选角色（也可创建后在第③步导入）</span>
          </div>
          <div class="field"><label>项目名称 *</label><input type="text" id="npName" placeholder="如：夏日麦田少年" /></div>
          <div class="field"><label>一句话创意 *</label><textarea id="npIdea" rows="3" placeholder="例：黄昏麦田，穿黄胶鞋的少年沿着土路走向远方，暖金色逆光"></textarea></div>
          <div class="field"><label>风格偏好 <span class="hint">点选卡片，或在下方自定义</span></label>
            <div class="style-presets" id="npStylePresets">
              ${STYLE_PRESETS.map(
                (s) =>
                  `<button type="button" class="style-preset" data-style="${esc(s.value)}" title="${esc(s.value)}"><span class="sp-emoji">${s.emoji}</span><span>${esc(s.label)}</span></button>`,
              ).join('')}
            </div>
            <input type="text" id="npStyle" placeholder="自定义风格，如：胶片质感 / 水墨×赛博混合" style="margin-top:8px" />
          </div>
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
          <div class="field" style="display:flex;align-items:flex-start;gap:8px;border:1px dashed var(--border,#2a3040);border-radius:10px;padding:10px 12px;background:rgba(99,102,241,.06)">
            <input type="checkbox" id="npAutoAll" style="width:auto;margin-top:2px" />
            <label for="npAutoAll" style="margin:0;cursor:pointer">
              <b>🚀 全自动成片</b>：创建后从「文案 → 分镜 → AI 自审 → 角色图 → 逐镜视频 → 配音 → 渲染成片」全自动推进，
              失败自动重试，卡住时停在人工介入点。适合把创意直接变成成片。<span class="hint">（需已配置 API Key；配音需 Fish Key，未配置自动跳过）</span>
            </label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" id="npCancel">取消</button>
          <button class="btn primary" id="npCreate">创建并逐步制作</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // P0：风格预设卡片点击 → 填入风格输入框并高亮；手动编辑时取消高亮
    const styleInput = $('#npStyle', overlay);
    overlay.querySelectorAll('.style-preset').forEach((b) => {
      b.addEventListener('click', () => {
        overlay.querySelectorAll('.style-preset').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        styleInput.value = b.dataset.style;
      });
    });
    if (styleInput)
      styleInput.addEventListener('input', () => {
        overlay
          .querySelectorAll('.style-preset')
          .forEach((x) => x.classList.toggle('active', x.dataset.style === styleInput.value));
      });
    // P2-7：创作模板（套用 / 删除；保存入口在成片渲染面板「存为创作模板」）
    let templates = [];
    let pickedFilmPreset = '';
    let pickedCharacters = []; // v2.5 系列模板：待导入的角色库 id
    const tplSel = $('#npTemplate', overlay);
    const tplDel = $('#npTplDel', overlay);
    const applyTemplate = (t) => {
      if (!t) {
        pickedCharacters = [];
        return;
      }
      if (t.idea) $('#npIdea', overlay).value = t.idea;
      if (t.style) {
        styleInput.value = t.style;
        styleInput.dispatchEvent(new Event('input'));
      }
      const setOpt = (sel, val) => {
        const el = $(sel, overlay);
        if (el && val && [...el.options].some((o) => o.value === val)) el.value = val;
      };
      setOpt('#npAspect', t.aspect_ratio);
      setOpt('#npSeconds', t.seconds);
      pickedFilmPreset = t.film_preset || '';
      // v2.5 系列模板：角色库引用（创建后自动导入）+ 命名规范（回填项目名，可再改集数）
      pickedCharacters = Array.isArray(t.character_ids) ? t.character_ids : [];
      const nameEl = $('#npName', overlay);
      if (t.naming && nameEl && !nameEl.value.trim()) nameEl.value = t.naming;
      const pickInfo = $('#npPickedInfo', overlay);
      if (pickInfo && pickedCharacters.length)
        pickInfo.textContent = `模板携带 ${pickedCharacters.length} 个角色，创建后自动导入`;
    };
    const reloadTemplates = async () => {
      try {
        const r = await api('/api/templates');
        templates = r.items || [];
      } catch {
        templates = [];
      }
      if (!tplSel) return;
      tplSel.innerHTML =
        '<option value="">（不使用模板）</option>' +
        templates
          .map(
            (t) =>
              `<option value="${esc(t.id)}">${esc(t.name)}${t.film_preset ? ` · ${esc(t.film_preset)}` : ''}${t.character_ids?.length ? ` · 🧑${t.character_ids.length}` : ''}</option>`,
          )
          .join('');
      tplSel.value = '';
      if (tplDel) tplDel.disabled = true;
    };
    if (tplSel)
      tplSel.onchange = () => {
        const t = templates.find((x) => x.id === tplSel.value);
        applyTemplate(t);
        if (tplDel) tplDel.disabled = !t;
      };
    if (tplDel)
      tplDel.onclick = async () => {
        const t = templates.find((x) => x.id === tplSel.value);
        if (!t) return;
        if (!confirm(`删除创作模板「${t.name}」？`)) return;
        try {
          await api(`/api/templates/${t.id}`, { method: 'DELETE' });
          toast('模板已删除', 'ok');
          await reloadTemplates();
        } catch (e) {
          toast('删除失败：' + e.message, 'err');
        }
      };
    reloadTemplates();
    // v2.5：新建项目时从角色库选角（与模板携带的 character_ids 合并）
    $('#npPickChars', overlay)?.addEventListener('click', () => {
      pickCharacters((ids) => {
        pickedCharacters = ids || [];
        const info = $('#npPickedInfo', overlay);
        if (info)
          info.textContent = ids?.length
            ? `已选 ${ids.length} 个角色，创建后自动导入`
            : '未选角色（也可创建后在第③步导入）';
      });
    });
    let cancelled = false; // v2.2.2：请求在途时关闭弹窗 = 取消本次创建
    const close = () => {
      cancelled = true;
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (
        e.target === overlay ||
        e.target.closest('[data-close]') ||
        e.target.classList.contains('modal-close') ||
        e.target.closest('#npCancel')
      )
        close();
    });
    $('#npCreate', overlay).onclick = async () => {
      const name = $('#npName', overlay).value.trim();
      const idea = $('#npIdea', overlay).value.trim();
      if (!name || !idea) {
        toast('请填写项目名称与创意', 'err');
        return;
      }
      const btn = $('#npCreate', overlay);
      btn.disabled = true;
      btn.textContent = '正在创建…（可随时关闭弹窗取消）';
      try {
        const p = await api('/api/projects', {
          method: 'POST',
          body: {
            name,
            idea,
            style: styleInput.value.trim(),
            aspect_ratio: $('#npAspect', overlay).value,
            seconds: $('#npSeconds', overlay).value,
          },
        });
        // 用户在创建请求在途时取消了弹窗：删除刚建的空项目并刷新列表，不再被强制带入新项目
        if (cancelled || !overlay.isConnected) {
          await api(`/api/projects/${p.id}`, { method: 'DELETE' }).catch(() => {});
          refresh();
          return;
        }
        const autoStoryboard = $('#npAutoStoryboard', overlay)?.checked !== false;
        const autoAll = $('#npAutoAll', overlay)?.checked === true;
        close();
        st.currentProjectId = p.id;
        if (autoAll) {
          // P3 全自动成片：先启动状态机，再渲染页面——保证首屏就带 auto_state 时间线容器，
          // 轮询即可局部刷新（v2.1 修复：先渲染后启动会导致容器缺失、页面看起来毫无反应）
          try {
            await api(`/api/projects/${p.id}/auto`, { method: 'POST' });
            toast('全自动成片已启动：文案→分镜→自审→角色图→视频→配音→渲染 将自动推进', 'ok');
            await renderProject(p.id); // auto_state 已落库，这次渲染必含时间线
            bindAutoTimelineEvents(p.id);
            startAutoPoll(p.id);
          } catch (e) {
            toast('全自动启动失败（可手动逐步制作）：' + e.message, 'err');
            await renderProject(p.id);
          }
          return;
        }
        await renderProject(p.id);
        // v2.5 系列模板：从角色库导入角色（多角色追加定稿，≤5）
        if (pickedCharacters.length) {
          try {
            const r = await api(`/api/projects/${p.id}/characters/import`, {
              method: 'POST',
              body: { character_ids: pickedCharacters.slice(0, 5) },
            });
            toast(`已从角色库导入 ${r.imported?.length || 0} 个角色`, 'ok');
            await renderProject(p.id);
          } catch (e) {
            toast('角色导入失败（可在第③步手动「📚 从角色库导入」）：' + e.message, 'err');
          }
        }
        // P2-7：套用模板携带的成片预设配方（若所选模板含配方且渲染面板已渲染出对应卡片）
        if (pickedFilmPreset) {
          document.querySelector(`#wsFilmPresets .film-preset[data-preset="${pickedFilmPreset}"]`)?.click();
        }
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
        if (cancelled || !overlay.isConnected) return; // 已取消创建，错误不再打扰
        toast('创建失败：' + e.message, 'err');
        btn.disabled = false;
        btn.textContent = '创建并逐步制作';
      }
    };
  }

  /* ---------------- 项目详情 ---------------- */
  /** v2.2.2：整页重绘前快照未保存输入、完成后回填，防止轮询/提交/自动成片打断用户编辑 */
  async function renderProject(id) {
    const pending = captureDirtyInputs(wsView);
    try {
      const out = await renderProjectInner(id);
      restoreDirtyInputs(pending);
      return out;
    } catch (e) {
      restoreDirtyInputs(pending); // 渲染失败也尽量回填，别让草稿丢在一次异常上
      throw e;
    }
  }
  async function renderProjectInner(id) {
    const [d, meta] = await Promise.all([api(`/api/projects/${id}`), getMeta()]);
    const p = d.project;
    const texts = d.texts || [];
    const images = d.images || [];
    const tasks = d.tasks || [];
    const shots = d.shots || [];
    st.currentShotCount = shots.length;
    st.projectsShotsCache = shots;
    const selVideo = (t) =>
      t.find((x) => x.kind === 'video_prompt' && x.selected) || t.find((x) => x.kind === 'video_prompt');
    const selChar =
      images.find((x) => x.kind === 'character' && x.selected) || images.find((x) => x.kind === 'character');
    const selVideoText = selVideo(texts);
    const completedShots = tasks.filter((t) => t.status === 'completed').length;
    // v1.5：已绑定镜头配音的镜头数（渲染时旁白覆盖率提示）
    const narratedShots = shots.filter((s) =>
      (d.tts || []).some((t) => t.kind === 'shot' && t.shot_id === s.id && t.local_path && !t.error_message),
    ).length;
    const stepsDone = {
      1: Boolean(p.idea),
      2: texts.some((t) => t.kind === 'video_prompt' || t.kind === 'storyboard') || shots.length > 0,
      3: Boolean(selChar),
      4: tasks.length > 0, // M2 起 projects.status 退役，纯聚合推导
      5: (d.tts || []).length > 0,
      6: Boolean(p.bgm?.song_id), // v2.2：BGM 独立步骤（可选，未选不影响渲染）
      7: completedShots >= 2, // v2.2：≥2 个完成镜头即可渲染成片（渲染置为最后一步）
    };
    const stepState = (n) => (stepsDone[n] ? 'done' : '');
    let renderJobs = [];
    try {
      renderJobs = (await api(`/api/projects/${id}/render/jobs`)).items || [];
    } catch {
      /* 旧后端兼容 */
    }
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
    const doneCount = [1, 2, 3, 4, 5, 6, 7].filter((n) => stepsDone[n]).length;
    ws.innerHTML = `
      <div class="ws-pad">
        <div class="ws-head">
          <button class="btn ghost" id="wsBack">← 项目列表</button>
          <h2>${esc(p.name)}</h2>
          ${p.idea ? `<span class="muted">${esc(p.idea)}</span>` : ''}
          <span class="spacer"></span>
          <button class="btn ghost sm" id="wsGuideToggle" title="显示/隐藏各步骤的新手说明卡">${guideOff() ? '📖 新手引导：关' : '📖 新手引导：开'}</button>
          <button class="btn ghost danger" id="wsDel" title="删除项目（关联的视频任务保留）">删除</button>
        </div>
        <div class="steps" id="wsSteps">
          <div class="step ${stepState(1)} ${st.currentStep === 1 ? 'active' : ''}" data-step="1"><span class="n">①</span>创意</div>
          <div class="step ${stepState(2)} ${st.currentStep === 2 ? 'active' : ''}" data-step="2"><span class="n">②</span>文案与提示词</div>
          <div class="step ${stepState(3)} ${st.currentStep === 3 ? 'active' : ''}" data-step="3"><span class="n">③</span>角色设定图</div>
          <div class="step ${stepState(4)} ${st.currentStep === 4 ? 'active' : ''}" data-step="4"><span class="n">④</span>视频生成</div>
          <div class="step ${stepState(5)} ${st.currentStep === 5 ? 'active' : ''}" data-step="5"><span class="n">⑤</span>配音</div>
          <div class="step ${stepState(6)} ${st.currentStep === 6 ? 'active' : ''}" data-step="6"><span class="n">⑥</span>背景音乐</div>
          <div class="step ${stepState(7)} ${st.currentStep === 7 ? 'active' : ''}" data-step="7"><span class="n">⑦</span>成片</div>
        </div>
        ${p.auto_state ? `<div id="wsAutoHolder" class="mt">${autoTimelineHTML(p.auto_state)}</div>` : '<div id="wsAutoHolder" class="mt" hidden></div>'}
        ${guideInfo ? `<div class="ws-guide"><span>👉 下一步：<b>${esc(guideInfo.label)}</b>（已完成 ${doneCount}/6 步）</span><span class="spacer"></span>${guideInfo.target ? `<button class="btn ghost sm" data-guide-goto="${guideInfo.target}">前往</button>` : ''}</div>` : ''}

        <!-- ② 文案与分镜 -->
        <div class="copy-sect">
          <h4>📝 文案与提示词 <span class="badge-selected" hidden id="wsCopyDone">已生成</span></h4>
          ${stepGuideHTML(2, !guideOff())}
          ${
            st.scriptBusy
              ? '<div class="ws-loading"><span class="spinner"></span> <span class="ws-loading-text">正在分析创意，梳理故事结构…</span></div>'
              : `
          <button class="btn primary sm" id="wsGenScript">✨ 生成 / 重新生成文案</button>
          <div class="hint mt">梗概、角色描述、场景描述一次生成；分镜在下方独立生成与编辑。</div>`
          }
          <div id="wsCopySections" class="mt">
            ${st.storyBusy ? '<div class="ws-loading"><span class="spinner"></span> <span class="ws-loading-text">正在拆解叙事节奏…</span></div>' : renderStoryboardArea(texts, shots, p, meta, d.tts || [])}
            ${renderTextSections(texts, ['script', 'character_desc', 'scene_desc'])}
          </div>
          ${stepNavHTML(2)}
        </div>

        <!-- ③ 角色设定 -->
        <div class="copy-sect" id="wsCharSection">
          <h4>🧑‍🎨 角色设定图 <span class="muted" style="font-weight:400">（参考图用于视频，减少角色幻觉）</span>
            <button class="btn ghost sm" id="wsCharLib" style="float:right" title="从角色库导入已收藏的角色（跨项目复用；可多角色）">📚 从角色库导入</button>
          </h4>
          ${stepGuideHTML(3, !guideOff())}
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
              ${
                st.imgGenBusy
                  ? '<div class="ws-loading mt"><span class="spinner"></span> <span class="ws-loading-text">正在生成候选图（约 10–90 秒），完成后在下方挑选…</span></div>'
                  : `<div class="row mt" style="display:flex;gap:8px;align-items:center">
                    <select id="wsImgCount" class="meta-tag" style="background:var(--bg)" title="一次生成的候选图数量">
                      <option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option>
                    </select>
                    <button class="btn primary sm" id="wsGenChar">🎨 生成角色图</button>
                  </div>`
              }
              <div class="hint mt">生成多张时点击其一作为种子图（绿色边框定稿）；不满意可再生成。</div>
            </div>
          </div>
          <div class="img-wall mt" id="wsCharWall">${images
            .filter((x) => x.kind === 'character')
            .map(imgCell)
            .join('')}</div>
          ${stepNavHTML(3)}
        </div>

        <!-- ④ 视频 -->
        <div class="copy-sect" id="wsVideoSection">
          <h4>🎬 发起视频任务</h4>
          ${stepGuideHTML(4, !guideOff())}
          <div class="video-assemble">
            <div class="ref-row">
              <div class="ref-img">${selChar ? `<img src="${esc(selChar.local_url || selChar.remote_url)}" alt="角色定稿图" />` : '<div class="muted" style="padding:30px 8px;text-align:center">未定稿</div>'}</div>
              <div class="ref-txt">
                ${
                  shots.length
                    ? `<b>角色定稿图：</b>${selChar ? '已就绪，所有镜头将引用该图（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」）' : '未定稿——请先在上方完成角色图定稿'}`
                    : `<b>分镜提示词：</b>${esc(selVideoText?.content || '（请先完成文案步骤）')}`
                }
              </div>
            </div>
            ${
              shots.length
                ? renderShotSubmitBlock(shots, tasks, selChar, st.batchBusy, st.batchHint)
                : `
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
            <div class="hint mt">将用：定稿角色图 + 分镜提示词（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」）</div>`
            }
          </div>
          ${`<div id="wsTaskList">${renderTaskList(tasks, shots)}</div>`}
          ${stepNavHTML(4)}
        </div>

        <!-- ⑤ 配音（Fish Audio TTS） -->
        <div class="copy-sect" id="wsTtsSection">
          <h4>🎙️ 配音（旁白 · Fish Audio TTS） <span class="muted" style="font-weight:400">可选：把分镜旁白变成人声，混入成片</span></h4>
          ${stepGuideHTML(5, !guideOff())}
          <div class="grid2">
            <div class="field">
              <label>逐镜配音（推荐）<span class="hint">按每镜「旁白文案」逐条合成并自动绑定对应镜头，渲染时与画面自动对齐</span></label>
              <div class="hint" id="wsTtsShotSummary" style="margin-bottom:8px">${(() => {
                const narrated = (shots || []).filter((s) => (s.narration || '').trim());
                const bound = (d.tts || []).filter(
                  (t) => t.kind === 'shot' && t.shot_id && t.local_path && !t.error_message,
                );
                return narrated.length
                  ? `分镜共 ${shots.length} 镜，其中 ${narrated.length} 镜有旁白文案 · 已生成配音 ${bound.length} 条`
                  : '分镜还没有旁白文案——到第②步给镜头填写「🎙️ 旁白文案」后再回来';
              })()}</div>
              <div class="row" style="display:flex;gap:8px;align-items:center">
                <button class="btn primary sm" id="wsTtsGenShots" ${(shots || []).some((s) => (s.narration || '').trim()) ? '' : 'disabled'}>🎙️ 为所有镜头生成配音</button>
                <span class="hint" id="wsTtsShotsHint"></span>
              </div>
            </div>
            <div class="field">
              <label>自由文稿配音（可选）<span class="hint">粘贴任意文稿整段合成，不绑定具体镜头</span></label>
              <textarea id="wsTtsText" rows="4" placeholder="粘贴要配音的文稿…">${esc(defaultTtsText(texts, shots))}</textarea>
              <div class="row" style="margin-top:6px;display:flex;gap:8px;align-items:center">
                <button class="btn ghost sm" id="wsTtsFillNarration" title="用每镜「旁白文案」字段填充（不包含画面提示词）">📖 从分镜旁白填充</button>
                <button class="btn ghost sm" id="wsTtsFillScript" title="用选定故事梗概填充">✍️ 从故事梗概填充</button>
              </div>
              <div class="row mt" style="display:flex;gap:8px;align-items:center">
                <label class="hint" style="display:flex;gap:6px;align-items:center">音色
                  <select id="wsTtsVoice"></select></label>
                <label class="hint" style="display:flex;gap:6px;align-items:center">语速
                  <input type="number" id="wsTtsSpeed" min="0.5" max="2" step="0.05" value="${esc(String(wsDefaultSpeed()))}" title="语速 0.5–2.0（旁白建议 0.9–1.0）" style="width:70px" /></label>
              </div>
              <div class="row mt" style="display:flex;gap:8px;align-items:center">
                <button class="btn ghost sm" id="wsTtsGen">🗣️ 合成自由文稿</button>
                <span class="hint" id="wsTtsHint">自由文稿配音不会绑定镜头，成片默认使用逐镜配音。</span>
              </div>
            </div>
          </div>
          <div class="hint mt">逐镜配音与画面自动对齐（渲染时按镜头起幅点混入）；配音为本地 mp3，可在下方配音墙试听/重生成/重新绑定。</div>
          <div id="wsTtsWall" class="mt">${renderTtsWall(d.tts || [], shots)}</div>
          <div class="mt" style="border-top:1px dashed #2a3244;padding-top:10px">
            <b>🎤 声音广场</b> <span class="hint">浏览 Fish 社区真实音色（按热度排行），试听后「＋备选」加入音色池，即出现在上方「默认音色」下拉</span>
            <div class="row" style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
              <select id="wsMkSort" class="meta-tag" style="background:var(--bg)">
                <option value="trending" selected>🔥 热门趋势</option>
                <option value="task_count">📈 最多使用</option>
                <option value="created_at">🆕 最新收录</option>
              </select>
              <select id="wsMkGender" class="meta-tag" style="background:var(--bg)">
                <option value="">性别不限</option><option value="male" selected>男声</option><option value="female">女声</option>
              </select>
              <select id="wsMkAge" class="meta-tag" style="background:var(--bg)">
                <option value="">年龄不限</option><option value="young">青年</option><option value="middle">中年</option><option value="old">成熟</option>
              </select>
              <button class="btn ghost sm" id="wsMkSearch">🔍 浏览声音</button>
            </div>
            <div id="wsMkPool" class="mt">${renderVoicePool(d.project)}</div>
            <div id="wsMkResults" class="mt"></div>
            <audio id="wsMkAudio" preload="none" style="display:none"></audio>
          </div>
          ${stepNavHTML(5)}
        </div>

        <!-- ⑥ 背景音乐（v2.2 独立步骤：渲染前置的最后准备，可选） -->
        <div class="copy-sect" id="wsBgmSection">
          <h4>🎵 背景音乐 <span class="muted" style="font-weight:400">可选：搜索在线曲库选用一首，渲染时循环铺底并自动闪避</span></h4>
          ${stepGuideHTML(6, !guideOff())}
          <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="wsBgmQuery" placeholder="搜索歌曲 / 歌手，如：夜空中最亮的星" style="flex:1;min-width:200px" />
            <button class="btn ghost sm" id="wsBgmSearch">🔍 搜索</button>
          </div>
          <div id="wsBgmCurrent" class="mt">${bgmCurrentHtml(p.bgm)}</div>
          <div id="wsBgmResults" class="mt"></div>
          <audio id="wsBgmAudio" preload="none" style="display:none"></audio>
          <div class="hint mt">BGM 音量与「旁白闪避」开关在下一步「高级配置」中调整；不选 BGM 也可直接渲染。</div>
          ${stepNavHTML(6)}
        </div>

        <!-- ⑦ 成片渲染（v2.2 置于最后一步；v2.0 风格预设 + 高级配置） -->
        <div class="copy-sect" id="wsRenderSection">
          <h4>🎞️ 成片渲染 <span class="muted" style="font-weight:400">已完成镜头 + 逐镜旁白 → 完整短片（本地 ffmpeg 合成）</span></h4>
          ${stepGuideHTML(7, !guideOff())}
          <!-- v2.1 渲染前预检：镜头就绪 / 旁白匹配 / 配乐状态 / 预计时长（红黄绿三态，随后台进度自动更新） -->
          <div class="precheck-row" id="wsPrecheck">${renderPrecheckHTML(d, completedShots, narratedShots, shots)}</div>
          <!-- P2：成片风格预设卡片（一键套用整套配方，小白一步到位） -->
          <div class="film-preset-row" id="wsFilmPresets">
            ${FILM_PRESETS.map(
              (p) => `
              <button type="button" class="film-preset" data-preset="${esc(p.id)}" title="${esc(p.desc)}">
                <span class="fp-emoji">${p.emoji}</span><span class="fp-label">${esc(p.label)}</span>
              </button>`,
            ).join('')}
          </div>
          <div class="film-recipe" id="wsFilmRecipe"></div>
          <div class="row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <select id="wsRAspect" class="meta-tag" style="background:var(--bg)" title="成片方向（默认跟随项目画幅）">
              <option value="16:9" ${p.aspect_ratio !== '9:16' ? 'selected' : ''}>横屏 16:9</option>
              <option value="9:16" ${p.aspect_ratio === '9:16' ? 'selected' : ''}>竖屏 9:16</option>
            </select>
            <span class="meta-tag" title="已绑定镜头配音的镜头数（在第⑤步配音墙中绑定）">🎙️ 旁白 ${narratedShots}/${shots.length} 镜</span>
            <span class="spacer" style="flex:1"></span>
            <button class="btn ghost" id="wsSaveTemplate" title="把本项目的创意/风格/画幅/时长与当前成片预设存成可复用模板（新建项目时套用）">💾 存为创作模板</button>
            <button class="btn ghost" id="wsRenderCompare" title="并排播放对比同项目的多版成片（需 ≥2 版已完成）">⚖️ 多版本对比</button>
            <button class="btn ghost" id="wsMatrix" title="一屏查看每镜的 视频/配音/时长校验/角色引用/定稿 take">📊 制作矩阵</button>
            <button class="btn ghost" id="wsChecklist" title="交付自检：创意/风格锚/角色/分镜/旁白/视频/配音/时长/BGM 九项就绪度">✅ 交付自检</button>
            <button class="btn primary" id="wsRenderBtn" ${completedShots >= 2 ? '' : 'disabled'} title="${completedShots >= 2 ? '创建后台渲染任务' : '至少需要 2 个已完成镜头'}">🎞️ 渲染成片（${completedShots} 镜就绪）</button>
          </div>
          <!-- P2：高级配置（分组折叠，默认收起；选中预设后可展开微调） -->
          <details class="adv-config" id="wsAdvConfig">
            <summary>⚙ 高级配置（转场 / 字幕 / 音频 / 卡片）</summary>
            <div class="adv-grid">
              <div class="adv-group">
                <b>🎬 转场</b>
                <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <select id="wsRTransitionType" class="meta-tag" style="background:var(--bg)" title="镜头间转场类型">
                    ${Object.entries(TRANSITION_LABELS)
                      .map(([v, l]) => `<option value="${esc(v)}" ${v === 'fade' ? 'selected' : ''}>${esc(l)}</option>`)
                      .join('')}
                  </select>
                  <label class="hint" style="display:flex;gap:6px;align-items:center">时长
                    <input type="range" id="wsRTransition" min="200" max="1500" step="100" value="600" style="width:110px" title="转场时长（毫秒）" />
                    <span id="wsRTransitionV">0.6s</span></label>
                </div>
              </div>
              <div class="adv-group">
                <b>💬 字幕</b>
                <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsRSubs" checked /> 烧录</label>
                  <select id="wsRSubStyle" class="meta-tag" style="background:var(--bg)" title="字幕样式">
                    ${Object.entries(SUBSTYLE_LABELS)
                      .map(
                        ([v, l]) =>
                          `<option value="${esc(v)}" ${v === 'white-outline' ? 'selected' : ''}>${esc(l)}</option>`,
                      )
                      .join('')}
                  </select>
                  <select id="wsRSubPos" class="meta-tag" style="background:var(--bg)" title="字幕位置">
                    ${Object.entries(SUBPOS_LABELS)
                      .map(
                        ([v, l]) => `<option value="${esc(v)}" ${v === 'bottom' ? 'selected' : ''}>${esc(l)}</option>`,
                      )
                      .join('')}
                  </select>
                  <label class="hint" style="display:flex;gap:6px;align-items:center">字号
                    <input type="range" id="wsRSubSize" min="24" max="72" step="2" value="42" style="width:110px" title="字幕字号" />
                    <span id="wsRSubSizeV">42</span></label>
                </div>
              </div>
              <div class="adv-group">
                <b>🔊 音频</b>
                <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <label class="hint" style="display:flex;gap:6px;align-items:center">BGM
                    <input type="range" id="wsRBgmVol" min="0" max="90" value="35" style="width:90px" title="背景音乐音量（有旁白时建议 20–40%）" />
                    <span id="wsRBgmVolV">35%</span></label>
                  <label class="hint" style="display:flex;gap:6px;align-items:center">旁白增益
                    <input type="range" id="wsRNarrVol" min="80" max="220" step="10" value="140" style="width:90px" title="旁白音量增益（默认 140%，让人声稳坐音乐之上）" />
                    <span id="wsRNarrVolV">140%</span></label>
                  <label class="hint" style="display:flex;gap:6px;align-items:center">旁白偏移
                    <input type="range" id="wsRNarrOffset" min="0" max="1500" step="100" value="500" style="width:110px" title="旁白相对镜头起幅点的进入时间" />
                    <span id="wsRNarrOffsetV">0.5s</span></label>
                  <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsRDuck" checked /> 旁白闪避</label>
                </div>
              </div>
              <div class="adv-group">
                <b>🏷️ 片头 / 片尾卡</b>
                <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsRTitle" checked /> 片头卡</label>
                  <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="wsREnd" checked /> 片尾卡</label>
                </div>
              </div>
            </div>
            <div class="hint mt">混音链：旁白高通+压缩+增益 → BGM 循环铺底+首尾淡入淡出 → 旁白闪避 → 全片响度标准化（-16 LUFS）。成片 1280×720@30，服务端后台渲染。</div>
          </details>
          <div id="wsRenderJobs" class="mt">${renderJobs.map(renderJobItem).join('')}</div>
        </div>
      </div>`;

    $('#wsBack').onclick = () => {
      st.currentProjectId = null;
      renderList();
    };
    // 步骤条点击跳转 + 下一步引导
    const stepTargets = {
      1: '#wsCopySections',
      2: '#wsCopySections',
      3: '#wsCharSection',
      4: '#wsVideoSection',
      5: '#wsTtsSection',
      6: '#wsBgmSection',
      7: '#wsRenderSection',
    };
    ws.querySelectorAll('.step[data-step]').forEach((el) => {
      el.onclick = () => {
        st.currentStep = Number(el.dataset.step);
        stepFollowUntil = Date.now() + 1500; // 滚动途中不让跟随逻辑覆盖点击选择
        document.querySelectorAll('.steps .step').forEach((s) => s.classList.toggle('active', s === el));
        document.querySelector(stepTargets[st.currentStep])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    const guideBtn = ws.querySelector('[data-guide-goto]');
    if (guideBtn) {
      guideBtn.onclick = () =>
        document.querySelector(guideBtn.dataset.guideGoto)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    bindStepScrollFollow();
    // P0：新手引导开关（记忆到 localStorage，重渲染以显示/隐藏说明卡）
    const guideToggle = $('#wsGuideToggle');
    if (guideToggle) {
      guideToggle.onclick = () => {
        setGuideOff(!guideOff());
        renderProject(p.id);
      };
    }
    // P0：步骤间导航（下一步带前置校验：拦截「下一步根本无法操作」的情况，可选步骤提示后放行）
    const gotoStep = (n) => {
      st.currentStep = n;
      stepFollowUntil = Date.now() + 1500; // 滚动途中不让跟随逻辑覆盖点击选择
      document
        .querySelectorAll('.steps .step')
        .forEach((s) => s.classList.toggle('active', s.dataset.step === String(n)));
      document.querySelector(stepTargets[n])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    ws.querySelectorAll('[data-step-prev]').forEach((b) => {
      b.onclick = () => gotoStep(Math.max(2, Number(b.dataset.stepPrev) - 1));
    });
    ws.querySelectorAll('[data-step-next]').forEach((b) => {
      b.onclick = () => {
        const n = Number(b.dataset.stepNext); // 当前步骤 → 跳 n+1
        if (n === 2 && !stepsDone[2]) {
          toast('先点本步「✨ 生成文案」与「✨ 生成分镜」，完成剧本再继续', 'warn');
          return;
        }
        if (n === 3 && !selChar && !confirm('尚未定稿角色图——后续镜头视频将无法引用角色外观一致性。仍要继续？')) return;
        if (n === 4 && !tasks.length) toast('提示：还没有提交镜头任务，配音可先准备', 'warn');
        if (n === 6 && !p.bgm?.song_id) toast('提示：未选 BGM 也可以渲染成片（纯旁白 / 静音）', 'warn');
        if (n === 6 && completedShots < 2) toast('提示：渲染需要至少 2 个已完成镜头，可先了解成片设置', 'warn');
        gotoStep(n + 1);
      };
    });
    $('#wsDel').onclick = async () => {
      if (!confirm(`确认删除项目「${p.name}」？文案与角色图将一并删除，视频任务保留。`)) return;
      try {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        toast('项目已删除', 'ok');
        st.currentProjectId = null;
        await renderList();
      } catch (e) {
        toast('删除失败：' + e.message, 'err');
      }
    };
    // M2：有分镜时旧的单任务提交控件不渲染，全部做存在性守卫绑定
    const genScriptBtn = $('#wsGenScript');
    if (genScriptBtn && !st.scriptBusy) genScriptBtn.onclick = () => genScript(p.id);
    const genCharBtn = $('#wsGenChar');
    if (genCharBtn) genCharBtn.onclick = () => genCharacterImage(p.id);
    const optCharBtn = $('#wsOptimizeChar');
    if (optCharBtn) optCharBtn.onclick = () => optimizeCharDesc(p.id);
    const charLibBtn = $('#wsCharLib');
    if (charLibBtn) charLibBtn.onclick = () => importFromLibrary(p.id); // v2.5 从角色库导入
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
          bus.emit('tasks-changed');
          if (st.currentProjectId === p.id) await renderProject(p.id);
        } catch (e) {
          toast('重拍失败：' + e.message, 'err');
          b.disabled = false;
        }
      };
    });
    document.querySelectorAll('#wsShotSubmit [data-take-pick]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/projects/${p.id}/shots/${Number(b.dataset.takePick)}/select-take`, {
            method: 'POST',
            body: { task_id: Number(b.dataset.task) },
          });
          toast('已选定定稿 take，成片渲染将优先使用这条', 'ok');
          await renderProject(p.id);
        } catch (e) {
          toast('选定失败：' + e.message, 'err');
        }
      };
    });
    document.querySelectorAll('#wsShotSubmit [data-take-auto]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/projects/${p.id}/shots/${Number(b.dataset.takeAuto)}/select-take`, {
            method: 'POST',
            body: { task_id: null },
          });
          toast('已恢复自动模式（渲染用最新完成条）', 'ok');
          await renderProject(p.id);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });
    const batchBtn = $('#wsBatchSubmit');
    if (batchBtn) batchBtn.onclick = () => runBatchSubmit(p.id);
    const stopBtn = $('#wsBatchStop');
    if (stopBtn) {
      stopBtn.onclick = () => {
        st.batchStop = true;
        toast('将在当前镜头提交完成后停止批量', 'warn');
      };
    }
    // 跳转任务中心
    bindGotoTaskLinks();
    // TTS 配音事件
    bindTtsEvents(p.id);
    // v1.3+ B3-7：成片渲染面板（渲染按钮 / 风格预设 / 高级配置 / 渲染任务轮询）与第⑥步 BGM 面板
    // 事件绑定与局部更新已拆至独立模块——渲染提交/轮询、BGM 选用/清除只改对应子树，不再整页重绘
    bindRenderPanel(p.id, renderJobs);
    bindBgmEvents(p.id);
    // v1.9 声音广场：备选池展示 + 浏览/试听/入池
    bindVoiceMarket(p.id);
    // P3：全自动成片运行中 → 时间线事件 + 状态轮询
    if (p.auto_state?.running) {
      bindAutoTimelineEvents(p.id);
      startAutoPoll(p.id);
    } else if (autoPollTimer && st.currentProjectId !== p.id) {
      clearInterval(autoPollTimer);
      autoPollTimer = null;
    }
  }

  async function refreshTasks() {
    const box = $('#wsTaskList');
    if (!box || !st.currentProjectId) return;
    try {
      const d = await api(`/api/projects/${st.currentProjectId}`);
      box.innerHTML = renderTaskList(d.tasks || [], d.shots || []);
      bindGotoTaskLinks();
      // v2.1：渲染预检随项目聚合同步刷新（视频后台完成时预检自动转绿）
      const pc = $('#wsPrecheck');
      if (pc) pc.innerHTML = precheckHtmlFromDetail(d);
    } catch {
      /* 静默：下次轮询自愈 */
    }
  }

  function bindGotoTaskLinks() {
    document.querySelectorAll('#wsTaskList [data-goto-task]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        $('#navTasks')?.click();
        const card = document.querySelector(`.card[data-id="${a.dataset.gotoTask}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }),
    );
  }
})();
