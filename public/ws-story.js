/* ws-story.js —— 创作工作台第②步：文案与分镜（M4-B3-6：自 workspace.js 拆出）
 * 生成/审查/对比采用文案与分镜、镜头编辑排序/单镜配音按钮、历史版本选用、文本版本选用。
 * busy/镜头缓存走共享 st；动作完成后的整页重刷统一广播 bus 'ws-project-changed' 由装配层调度。
 * 依赖：common.js、state.js、ws-state.js（st）、ws-util.js、ws-tts.js（genShotTts）、
 *       ws-render.js（narrMeterHTML）、compare.js。
 */
import { $, esc, toast, api, openModal } from './common.js';
import { bus } from './state.js';
import { st } from './ws-state.js';
import { stageHints, STAGES_SCRIPT, STAGES_STORY } from './ws-util.js';
import { genShotTts } from './ws-tts.js';
import { narrMeterHTML } from './ws-render.js';
import { submitRender } from './ws-render-panel.js';
import { compare } from './compare.js';

/** 旁白计量实时刷新：旁白输入 / 时长下拉联动（渲染后由 bindStoryboardEvents 统一绑定） */
function bindNarrMeters() {
  document.querySelectorAll('#wsShotList .shot-card').forEach((card) => {
    const ta = card.querySelector('[data-shot-narration]');
    const meter = card.querySelector('[data-narr-meter]');
    const secSel = card.querySelector('[data-shot-seconds]');
    if (!ta || !meter) return;
    const update = () => {
      meter.innerHTML = narrMeterHTML(ta.value, secSel?.value);
    };
    ta.oninput = update;
    if (secSel) secSel.onchange = update;
  });
}

/** v2.5：分镜批量导入——粘贴 JSON 数组一次建全部镜头（服务端统一校验：字数/秒数/角色引用/总数） */
function bulkImportShots(projectId) {
  const bodyHTML = `
    <p class="hint">粘贴分镜 JSON 数组（字段：<code>title?</code> <code>video_prompt</code>（必填）<code>seconds?</code> <code>narration?</code> <code>use_character_ref?</code> <code>ref_image_ids?</code>）。</p>
    <textarea id="wsBulkJson" rows="10" style="width:100%;font-family:monospace" placeholder='[
  {"title":"镜1","video_prompt":"黄昏的海港…","seconds":"10","narration":"旁白一…"}
]'></textarea>
    <div class="mt">
      <label style="margin-right:14px"><input type="radio" name="wsBulkMode" value="append" checked /> 追加到现有镜头</label>
      <label><input type="radio" name="wsBulkMode" value="replace" /> 替换全部镜头</label>
    </div>
    <p class="hint mt">服务端会一次性校验：提示词非空 / 秒数 4–12 / 旁白 ≤ 秒数×4 / ref_image_ids 必须是本项目已定稿角色图 / 总数 ≤ 20。</p>`;
  openModal({
    title: '📥 批量导入分镜',
    bodyHTML,
    footHTML: '<button class="btn primary sm" data-do-bulk>导入</button>',
    onMount: (el, close) => {
      el.querySelector('[data-do-bulk]').addEventListener('click', async () => {
        let shots;
        try {
          shots = JSON.parse(el.querySelector('#wsBulkJson').value);
        } catch (e) {
          return toast('JSON 解析失败：' + e.message, 'err');
        }
        const mode = el.querySelector('input[name=wsBulkMode]:checked')?.value || 'append';
        try {
          const r = await api(`/api/projects/${projectId}/shots/bulk`, { method: 'POST', body: { shots, mode } });
          toast(`已导入 ${r.imported} 个镜头`, 'ok');
          close();
          bus.emit('ws-project-changed', projectId);
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    },
  });
}

function bindStoryboardEvents(projectId) {
  const gen = $('#wsGenStoryboard');
  if (gen) gen.onclick = () => genStoryboard(projectId);
  // v2.5：分镜批量导入（粘贴 JSON 一次建全部镜头）
  const bulk = $('#wsBulkShots');
  if (bulk) bulk.onclick = () => bulkImportShots(projectId);
  // P3 L1：AI 审查分镜（报告窗逐条采纳修订）
  const reviewBtn = $('#wsReviewSb');
  if (reviewBtn) reviewBtn.onclick = () => reviewStoryboard(projectId);
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
        bus.emit('ws-project-changed', projectId);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }
  document.querySelectorAll('#wsShotList [data-apply-sb]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('选用该历史分镜版本？当前镜头列表将被覆盖（可再次选用其他版本恢复）。')) return;
      try {
        await api(`/api/projects/${projectId}/storyboard/apply`, {
          method: 'POST',
          body: { text_id: Number(b.dataset.applySb) },
        });
        toast('已选用该分镜版本', 'ok');
        bus.emit('ws-project-changed', projectId);
      } catch (e) {
        toast(e.message, 'err');
      }
    }),
  );
  document.querySelectorAll('#wsShotList .shot-card').forEach((card) => {
    const id = Number(card.dataset.shotId);
    // v2.1：单镜头配音（用该镜旁白文案合成并自动绑定）
    const ttsBtn = card.querySelector('[data-shot-tts]');
    if (ttsBtn) {
      // 记下渲染时的原始文案（配本镜旁白 / 重配本镜），失败恢复时原样还原
      ttsBtn.dataset.label = ttsBtn.textContent;
      ttsBtn.onclick = async () => {
        ttsBtn.disabled = true;
        ttsBtn.textContent = '配音中…';
        const done = await genShotTts(projectId, id, '本镜');
        bus.emit('ws-project-changed', projectId);
        if (!done && ttsBtn.isConnected) {
          ttsBtn.disabled = false;
          ttsBtn.textContent = ttsBtn.dataset.label;
        }
      };
    }
    // P2-5：配音并重渲（重配本镜配音 → 立即触发一次成片渲染）
    const rerenderBtn = card.querySelector('[data-shot-rerender]');
    if (rerenderBtn) {
      const rrLabel = rerenderBtn.textContent;
      rerenderBtn.onclick = async () => {
        if (!confirm('将用本镜最新旁白重新配音，并立即渲染一版成片（后台进行）。继续？')) return;
        rerenderBtn.disabled = true;
        rerenderBtn.textContent = '配音中…';
        const okTts = await genShotTts(projectId, id, '本镜');
        if (!okTts) {
          if (rerenderBtn.isConnected) {
            rerenderBtn.disabled = false;
            rerenderBtn.textContent = rrLabel;
          }
          return;
        }
        rerenderBtn.textContent = '提交渲染…';
        try {
          await submitRender(projectId);
          toast('已重配本镜配音并提交渲染（后台合成中，可在第⑦步查看）', 'ok');
          bus.emit('ws-project-changed', projectId);
        } catch (e) {
          toast('重渲失败：' + e.message, 'err');
          if (rerenderBtn.isConnected) {
            rerenderBtn.disabled = false;
            rerenderBtn.textContent = rrLabel;
          }
        }
      };
    }
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
          bus.emit('ws-project-changed', projectId);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    }
    const del = card.querySelector('[data-shot-del]');
    if (del) {
      del.onclick = async () => {
        if (!confirm('删除该镜头？已提交的该镜头视频任务会保留在任务中心。')) return;
        try {
          await api(`/api/projects/${projectId}/shots/${id}`, { method: 'DELETE' });
          toast('镜头已删除', 'ok');
          bus.emit('ws-project-changed', projectId);
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    }
    const up = card.querySelector('[data-shot-up]');
    if (up) up.onclick = () => moveShot(projectId, card, -1);
    const down = card.querySelector('[data-shot-down]');
    if (down) down.onclick = () => moveShot(projectId, card, 1);
  });
  // v2.1：旁白计量条实时刷新（input / 时长变更联动）
  bindNarrMeters();
}

async function moveShot(projectId, card, dir) {
  const list = [...document.querySelectorAll('#wsShotList .shot-card')].map((c) => Number(c.dataset.shotId));
  const idx = list.indexOf(Number(card.dataset.shotId));
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= list.length) return;
  [list[idx], list[j]] = [list[j], list[idx]];
  try {
    await api(`/api/projects/${projectId}/shots/reorder`, { method: 'POST', body: { ids: list } });
    bus.emit('ws-project-changed', projectId);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- P3 L1：分镜 AI 审查（报告窗 + 逐条采纳修订） ---------------- */
const SEV_LABEL = { high: '高', medium: '中', low: '低' };
const FIELD_LABEL = { video_prompt: '画面提示词', narration: '旁白', seconds: '时长' };

async function reviewStoryboard(projectId) {
  const btn = $('#wsReviewSb');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '审查中…';
  }
  let r;
  try {
    r = await api(`/api/projects/${projectId}/storyboard/review`, { method: 'POST' });
  } catch (e) {
    toast('审查失败：' + e.message, 'err');
    return;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔍 AI 审查分镜';
    }
  }
  if (!r.parsed) {
    toast('模型未按结构化输出审查结果（原始内容见日志）', 'warn');
    return;
  }
  if (!r.issues || !r.issues.length) {
    toast(`审查通过：${r.overall || '未发现问题'}`, 'ok');
    return;
  }
  // 报告窗（动态 modal）
  const nonHigh = r.issues.filter((it) => it.severity !== 'high').length;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const itemHTML = (it, i) => `
      <div class="rv-item" data-i="${i}">
        <div class="rv-head">
          <span class="rv-sev sev-${esc(it.severity)}">${SEV_LABEL[it.severity] || it.severity}</span>
          <b>镜头 ${esc(String(it.shot_seq))} · ${esc(FIELD_LABEL[it.field] || it.field)}</b>
          <span class="spacer" style="flex:1"></span>
          <button class="btn primary sm" data-adopt="${i}">采纳修订</button>
        </div>
        <div class="rv-issue">${esc(it.issue)}</div>
        <details class="rv-rev"><summary>修订后文本</summary><div>${esc(it.revised)}</div></details>
      </div>`;
  overlay.innerHTML = `
      <div class="modal wide">
        <div class="modal-head"><h2>🔍 分镜 AI 审查报告</h2><button class="modal-close">✕</button></div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:10px">总体：${esc(r.overall || '')} —— 共 ${r.issues.length} 项建议。逐条采纳会直接写入对应镜头；全自动模式下中低优先级已自动采纳。${nonHigh ? `可用「采纳全部非 high」一次性应用 ${nonHigh} 项中/低优先级修订（高优先级硬伤建议逐条确认）。` : ''}</div>
          <div class="rv-list">${r.issues.map(itemHTML).join('')}</div>
        </div>
        <div class="modal-foot">
          ${nonHigh ? `<button class="btn primary sm" id="rvAdoptNonHigh">✅ 采纳全部非 high（${nonHigh} 项）</button>` : ''}
          <span class="spacer" style="flex:1"></span>
          <button class="btn ghost">关闭</button>
        </div>
      </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.modal-close') || e.target.closest('.btn.ghost')) close();
  });
  const shotBySeq = new Map((st.projectsShotsCache || []).map((s) => [s.seq, s]));
  const adopted = new Set();
  // 共享采纳逻辑：按 seq 找镜头 → PATCH 该字段；返回 {ok} 或 {missing} 或抛错
  const adoptOne = async (i) => {
    if (adopted.has(i)) return { ok: true, skipped: true };
    const it = r.issues[i];
    const shot = shotBySeq.get(Number(it.shot_seq));
    if (!shot) return { ok: false, missing: true };
    await api(`/api/projects/${projectId}/shots/${shot.id}`, {
      method: 'PATCH',
      body: { [it.field]: it.revised },
    });
    adopted.add(i);
    return { ok: true };
  };
  const markDone = (i) => {
    const item = overlay.querySelector(`.rv-item[data-i="${i}"]`);
    if (!item) return;
    item.classList.add('rv-done');
    const b = item.querySelector('[data-adopt]');
    if (b) {
      b.disabled = true;
      b.textContent = '✓ 已采纳';
    }
  };
  overlay.querySelectorAll('[data-adopt]').forEach((b) => {
    b.onclick = async () => {
      const i = Number(b.dataset.adopt);
      b.disabled = true;
      b.textContent = '写入中…';
      try {
        const res = await adoptOne(i);
        if (!res.ok) {
          toast('找不到对应镜头（分镜可能已变化，请刷新后重试）', 'err');
          b.disabled = false;
          b.textContent = '采纳修订';
          return;
        }
        markDone(i);
        toast(`镜头 ${r.issues[i].shot_seq} 的${FIELD_LABEL[r.issues[i].field] || r.issues[i].field}已更新`, 'ok');
        bus.emit('ws-project-changed', projectId);
      } catch (e2) {
        toast('采纳失败：' + e2.message, 'err');
        b.disabled = false;
        b.textContent = '采纳修订';
      }
    };
  });
  // P1-3：一键采纳全部非 high（medium/low），高优先级硬伤留人工逐条确认
  const batchBtn = overlay.querySelector('#rvAdoptNonHigh');
  if (batchBtn) {
    batchBtn.onclick = async () => {
      const targets = r.issues.map((_it, i) => i).filter((i) => r.issues[i].severity !== 'high');
      batchBtn.disabled = true;
      let okN = 0;
      let missN = 0;
      let failN = 0;
      for (const i of targets) {
        batchBtn.textContent = `采纳中…（${okN + missN + failN}/${targets.length}）`;
        try {
          const res = await adoptOne(i);
          if (res.ok) {
            okN += 1;
            markDone(i);
          } else {
            missN += 1;
          }
        } catch {
          failN += 1;
        }
      }
      if (okN) bus.emit('ws-project-changed', projectId);
      const parts = [`已采纳 ${okN} 项`];
      if (missN) parts.push(`${missN} 项找不到镜头`);
      if (failN) parts.push(`${failN} 项失败`);
      toast(parts.join('，'), failN || missN ? 'warn' : 'ok');
      batchBtn.textContent = okN === targets.length ? '✓ 已全部采纳' : `✅ 采纳全部非 high（${targets.length} 项）`;
      batchBtn.disabled = okN === targets.length;
    };
  }
}

async function genStoryboard(projectId) {
  if (st.storyBusy) return; // 防重入
  if (st.currentShotCount > 0 && !confirm('重新生成分镜：将先与当前分镜对比，由你选择采用（历史版本保留），继续？'))
    return;
  st.storyBusy = true;
  bus.emit('ws-project-changed', projectId); // 装配层重绘 → 显示「正在拆解叙事节奏…」
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
    const renderShots = (arr) =>
      (arr || [])
        .map(
          (s, i) =>
            `<div class="cmp-field"><b>镜头 ${esc(String(s.seq ?? i + 1))}${s.title ? ` · ${esc(s.title)}` : ''}</b><p>${esc(s.video_prompt || '')}</p></div>`,
        )
        .join('');
    compare({
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
        } catch (e) {
          toast(e.message, 'err');
        }
        bus.emit('ws-project-changed', projectId);
      },
      onKeep: async () => {
        toast('已保留当前分镜（新版本已存入历史，可随时选用）', 'ok');
        bus.emit('ws-project-changed', projectId);
      },
    });
  } catch (e) {
    toast('分镜生成失败：' + e.message, 'err');
  } finally {
    st.storyBusy = false;
    stopHints?.();
    bus.emit('ws-project-changed', projectId);
  }
}

async function promoteToStoryboard(projectId) {
  try {
    const d = await api(`/api/projects/${projectId}`);
    const sel =
      (d.texts || []).find((t) => t.kind === 'video_prompt' && t.selected) ||
      (d.texts || []).find((t) => t.kind === 'video_prompt');
    const content = sel?.content?.trim();
    if (!content) {
      toast('没有可用的视频提示词，请先生成文案或手写', 'err');
      return;
    }
    await api(`/api/projects/${projectId}/shots`, {
      method: 'POST',
      body: { title: '镜头 1', video_prompt: content },
    });
    toast('已把当前视频提示词升级为 1 个镜头', 'ok');
    bus.emit('ws-project-changed', projectId);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 文案分区版本绑定（保存修改 / 选用某版本） */
function bindTextSectionEvents(projectId) {
  document.querySelectorAll('#wsCopySections [data-save-text]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ta = b.closest('.copy-sect').querySelector('textarea');
      if (!ta) return;
      try {
        await api(`/api/projects/${projectId}/texts/${b.dataset.saveText}`, {
          method: 'PATCH',
          body: { content: ta.value },
        });
        toast('已保存', 'ok');
        bus.emit('ws-project-changed', projectId);
      } catch (e) {
        toast(e.message, 'err');
      }
    }),
  );
  document.querySelectorAll('#wsCopySections [data-use-text]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/projects/${projectId}/select-text`, {
          method: 'POST',
          body: { text_id: Number(b.dataset.useText) },
        });
        toast('已选用该版本', 'ok');
        bus.emit('ws-project-changed', projectId);
      } catch (e) {
        toast(e.message, 'err');
      }
    }),
  );
}

/* ---------------- 生成文案（首次直接采用；已有文案时对比二选一） ---------------- */
const SCRIPT_FIELDS = [
  ['script', '故事梗概'],
  ['video_prompt', '视频提示词'],
  ['character_desc', '角色外观'],
  ['scene_desc', '场景描述'],
];

/** 生成文案：首次生成直接采用；已有文案时落库不选中，弹对比窗由用户二选一。返回是否成功 */
async function genScript(projectId) {
  if (st.scriptBusy) return false; // 防双击并发（两次 LLM 调用 + 两条重复版本）
  st.scriptBusy = true;
  bus.emit('ws-project-changed', projectId); // 装配层重绘 → 显示「正在分析创意…」
  let stopHints = null;
  try {
    stopHints = stageHints(['#wsCopySections .ws-loading-text'], STAGES_SCRIPT);
    const { project, texts } = await api(`/api/projects/${projectId}`);
    const hasOld = SCRIPT_FIELDS.some(([k]) => (texts || []).some((t) => t.kind === k));
    const r = await api('/api/llm/script', {
      method: 'POST',
      body: {
        idea: project.idea,
        style: project.style,
        aspect_ratio: project.aspect_ratio,
        seconds: project.seconds,
        project_id: projectId,
        auto_select: !hasOld,
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
    const renderSide = (map) =>
      SCRIPT_FIELDS.map(
        ([k, label]) => `<div class="cmp-field"><b>${esc(label)}</b><p>${esc(map[k] || '（无）')}</p></div>`,
      ).join('');
    compare({
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
        } catch (e) {
          toast(e.message, 'err');
        }
        bus.emit('ws-project-changed', projectId);
      },
      onKeep: async () => {
        toast('已保留当前文案（新版本已存入历史，可随时选用）', 'ok');
        bus.emit('ws-project-changed', projectId);
      },
    });
    return true;
  } catch (e) {
    toast('文案生成失败：' + e.message, 'err');
    return false;
  } finally {
    st.scriptBusy = false;
    stopHints?.();
    // 用户可能已离开该项目视图，装配层按 st.currentProjectId 判断后重绘
    bus.emit('ws-project-changed', projectId);
  }
}

export { bindNarrMeters, bindStoryboardEvents, bindTextSectionEvents, genScript, genStoryboard, SCRIPT_FIELDS };
