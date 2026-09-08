/* ws-bgm.js —— 创作工作台第⑥步：背景音乐面板事件绑定（M4-B3-7：自 workspace.js 拆出）
 * 在线曲库搜索 / 试听 / 选用 / 清除。动作完成后做「局部更新」：
 * 只刷新 #wsBgmCurrent 与步骤⑥圆点与 #wsPrecheck，不整页重绘（避免清空其它步骤未保存输入）。
 * 依赖：common.js、ws-render.js（bgmCurrentHtml / fmtSecs / precheckHtmlFromDetail）。
 */
import { $, esc, toast, api } from './common.js';
import { bgmCurrentHtml, fmtSecs, precheckHtmlFromDetail } from './ws-render.js';

/** 选用 / 清除成功后的局部刷新：更新当前 BGM 卡、配乐预检 chip、步骤⑥圆点 */
async function refreshBgmArea(projectId) {
  let d;
  try {
    d = await api(`/api/projects/${projectId}`);
  } catch {
    return; // 静默：下次整页渲染自愈
  }
  const cur = $('#wsBgmCurrent');
  if (cur) cur.innerHTML = bgmCurrentHtml(d.project?.bgm);
  const step = document.querySelector('#wsSteps .step[data-step="6"]');
  if (step) step.classList.toggle('done', Boolean(d.project?.bgm?.song_id));
  const pc = $('#wsPrecheck');
  if (pc) pc.innerHTML = precheckHtmlFromDetail(d);
}

/** 第⑥步 BGM 面板：搜索 / 试听 / 选用 / 清除（选用与清除成功后局部更新，不整页重绘） */
function bindBgmEvents(projectId) {
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
        box.innerHTML = items.length
          ? items
              .map(
                (s) => `
            <div class="ver-item" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span><b>${esc(s.name)}</b> ${esc(s.artist)}${s.album ? ` · <span class="muted">${esc(s.album)}</span>` : ''}</span>
              <span class="meta-tag">${fmtSecs(s.duration_s)}</span>
              <span class="spacer" style="flex:1"></span>
              <button class="btn ghost sm" data-bgm-play="${s.id}" data-level="${esc(s.levels?.[1] || 'exhigh')}">▶ 试听</button>
              <button class="btn ghost sm" data-bgm-pick="${s.id}" data-name="${esc(s.name)}" data-artist="${esc(s.artist)}" data-album="${esc(s.album)}">选用</button>
            </div>`,
              )
              .join('')
          : '<span class="hint">没有找到结果</span>';
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
              await api(`/api/projects/${projectId}/bgm`, {
                method: 'POST',
                body: {
                  song_id: b.dataset.bgmPick,
                  name: b.dataset.name,
                  artist: b.dataset.artist,
                  album: b.dataset.album,
                },
              });
              toast('BGM 已选用（已下载到本地缓存）', 'ok');
              await refreshBgmArea(projectId);
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
        await api(`/api/projects/${projectId}/bgm`, { method: 'DELETE' });
        toast('已清除 BGM 选择', 'ok');
        await refreshBgmArea(projectId);
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  }
}

export { bindBgmEvents };
