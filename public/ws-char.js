/* ws-char.js —— 创作工作台第③步：角色设定图（M4-B3-5：自 workspace.js 拆出）
 * 角色描述 AI 优化 optimizeCharDesc / 生成角色图 genCharacterImage / 图墙定稿与删除 bindWallEvents。
 * 生成中 busy（st.imgGenBusy）与完成后的整页重刷均经共享 st / bus 'ws-project-changed' 与装配层协作。
 * 依赖：common.js、state.js（bus）、ws-state.js（st）、ws-util.js（stageHints、STAGES_IMG）、compare.js。
 */
import { $, toast, api } from './common.js';
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
  });
}

export { optimizeCharDesc, genCharacterImage, bindWallEvents };
