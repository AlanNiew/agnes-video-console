/* ws-char.js —— 创作工作台第③步：角色设定图（M4-B3-5：自 workspace.js 拆出）
 * 角色描述 AI 优化 optimizeCharDesc / 生成角色图 genCharacterImage / 图墙定稿与删除 bindWallEvents。
 * 生成中 busy（st.imgGenBusy）与完成后的整页重刷均经共享 st / bus 'ws-project-changed' 与装配层协作。
 * 依赖：common.js、state.js（bus）、ws-state.js（st）、ws-util.js（stageHints、STAGES_IMG）、compare.js。
 */
import { $, esc, toast, api, openModal } from './common.js';
import { bus } from './state.js';
import { st } from './ws-state.js';
import { stageHints, STAGES_IMG } from './ws-util.js';
import { compare } from './compare.js';

/* 角色描述 AI 优化（用户自主选择是否采用，优化后先对比） */
const CHAR_OPTIMIZE_PROMPT =
  '你是角色设定师。把用户的角色描述优化为适合 AI 角色立绘生成的设定文本，100 字内，必含要素：性别年龄、发型发色、五官特征、表情气质、服装款式与颜色、体型、有辨识度的配饰。规则：不添加用户未提及的职业、背景等设定；保持原描述的核心特征不变；只输出设定文本本身，不要任何解释或前缀。';

async function optimizeCharDesc() {
  const ta = $('#wsCharDesc');
  if (!ta) return;
  const cur = ta.value.trim();
  if (!cur) {
    toast('请先填写角色外观描述', 'err');
    return;
  }
  const btn = $('#wsOptimizeChar');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '优化中…';
  }
  try {
    const r = await api('/api/llm/chat', {
      method: 'POST',
      body: { system: CHAR_OPTIMIZE_PROMPT, messages: [{ role: 'user', content: cur }], temperature: 0.7 },
    });
    const adopt = () => {
      ta.value = r.content.trim();
      toast('已采用优化描述（需点「生成角色图」才会生效，或手动保存到文案）', 'ok');
    };
    if (compare) {
      compare({
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
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✨ AI 优化描述';
    }
  }
}

async function genCharacterImage(projectId) {
  if (st.imgGenBusy) return; // 防双击并发
  const desc = $('#wsCharDesc')?.value.trim();
  if (!desc) {
    toast('请先填写角色外观描述', 'err');
    return;
  }
  st.imgGenBusy = true;
  bus.emit('ws-project-changed', projectId); // 装配层重绘 → 显示「正在生成候选图…」
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
    st.imgGenBusy = false;
    stopHints?.();
    bus.emit('ws-project-changed', projectId);
  }
}

function bindWallEvents(projectId) {
  document.querySelectorAll('#wsCharWall .img-cell').forEach((cell) => {
    cell.addEventListener('click', async () => {
      if (cell.classList.contains('selected')) return;
      try {
        await api(`/api/projects/${projectId}/select-image`, {
          method: 'POST',
          body: { image_id: Number(cell.dataset.imgId) },
        });
        toast('已定稿，后续视频将引用该角色图', 'ok');
        bus.emit('ws-project-changed', projectId);
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    const del = cell.querySelector('.del');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除这张角色图？')) return;
      try {
        await api(`/api/images/${cell.dataset.imgId}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        bus.emit('ws-project-changed', projectId);
      } catch (e2) {
        toast(e2.message, 'err');
      }
    });
    // v2.5：收藏到角色库（跨项目复用）
    const fav = cell.querySelector('.fav');
    if (fav) {
      fav.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = prompt('角色名（存入角色库，可在其它项目「从角色库导入」复用）：');
        if (!name || !name.trim()) return;
        try {
          await api('/api/characters', {
            method: 'POST',
            body: { name: name.trim(), project_id: projectId, image_id: Number(cell.dataset.imgId) },
          });
          toast(`已收藏「${name.trim()}」到角色库`, 'ok');
        } catch (e2) {
          toast(e2.message, 'err');
        }
      });
    }
  });
}

/** v2.5：从角色库导入角色到本项目（多选，≤5；追加定稿为多角色） */
async function importFromLibrary(projectId) {
  let items;
  try {
    items = (await api('/api/characters')).items || [];
  } catch (e) {
    return toast(e.message, 'err');
  }
  if (!items.length) {
    return toast('角色库为空：先在任一项目定稿角色图后点 ⭐ 收藏', 'err');
  }
  const bodyHTML = `<div class="ch-lib">${items
    .map(
      (c) => `<label class="ch-lib-item">
        <input type="checkbox" value="${esc(c.id)}" />
        <img src="${esc(c.local_url || c.remote_url)}" alt="${esc(c.name)}" />
        <span>${esc(c.name)}${c.series ? ` <em class="muted">${esc(c.series)}</em>` : ''}${
          c.wardrobe ? `<br /><small class="muted">${esc(c.wardrobe)}</small>` : ''
        }</span>
      </label>`,
    )
    .join(
      '',
    )}</div><p class="hint mt">勾选后导入（追加为定稿角色图，最多 5 个/次）；导入后可在此项目的分镜里按镜头选角色。</p>`;
  openModal({
    title: '📚 从角色库导入',
    bodyHTML,
    footHTML: '<button class="btn primary sm" data-do-import>导入所选</button>',
    onMount: (el, close) => {
      el.querySelector('[data-do-import]').addEventListener('click', async () => {
        const ids = [...el.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
        if (!ids.length) return toast('请先勾选角色', 'err');
        try {
          const r = await api(`/api/projects/${projectId}/characters/import`, {
            method: 'POST',
            body: { character_ids: ids },
          });
          toast(`已导入 ${r.imported?.length || 0} 个角色`, 'ok');
          close();
          bus.emit('ws-project-changed', projectId);
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    },
  });
}

/** v2.5：从角色库挑选角色（仅选择、不导入；回调所选 id 数组）——供新建项目/后续编排使用 */
async function pickCharacters(onPicked) {
  let items;
  try {
    items = (await api('/api/characters')).items || [];
  } catch (e) {
    return toast(e.message, 'err');
  }
  if (!items.length) {
    return toast('角色库为空：先在任一项目定稿角色图后点 ⭐ 收藏', 'err');
  }
  const bodyHTML = `<div class="ch-lib">${items
    .map(
      (c) => `<label class="ch-lib-item">
        <input type="checkbox" value="${esc(c.id)}" />
        <img src="${esc(c.local_url || c.remote_url)}" alt="${esc(c.name)}" />
        <span>${esc(c.name)}${c.series ? ` <em class="muted">${esc(c.series)}</em>` : ''}${
          c.wardrobe ? `<br /><small class="muted">${esc(c.wardrobe)}</small>` : ''
        }</span>
      </label>`,
    )
    .join('')}</div><p class="hint mt">勾选后点「确定」（最多 5 个）；新建项目时会自动导入为定稿角色图。</p>`;
  openModal({
    title: '📚 从角色库选角',
    bodyHTML,
    footHTML: '<button class="btn primary sm" data-do-pick>确定</button>',
    onMount: (el, close) => {
      el.querySelector('[data-do-pick]').addEventListener('click', () => {
        const ids = [...el.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
        close();
        onPicked?.(ids.slice(0, 5));
      });
    },
  });
}

export { optimizeCharDesc, genCharacterImage, bindWallEvents, importFromLibrary, pickCharacters };
