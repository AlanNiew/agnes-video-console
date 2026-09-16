/* works-panel.js —— 作品库视图（我的作品）与作品详情弹窗（M4-B2：自 app.js 拆出）
 * GET /api/works 汇总卡片墙 → 点卡开详情：内嵌播放器（最新成片）+ 全套下载 + 目录复制。
 * 依赖：common.js。由 app 装配（切到作品视图时调用 loadWorks）。
 */
import { $, esc, fmtTime, toast, api } from './common.js';
import { qualityFlags } from './ws-render.js';

let worksCache = []; // 最近一次 /api/works 结果（详情弹窗复用）

async function loadWorks() {
  const grid = $('#worksGrid');
  try {
    const r = await api('/api/works');
    worksCache = r.items || [];
    grid.innerHTML = worksCache.map(workCardHTML).join('');
    $('#worksEmpty').hidden = worksCache.length > 0;
    // 卡片点击 → 详情弹窗
    grid.querySelectorAll('.work-card').forEach((card) => {
      card.onclick = () => {
        const item = worksCache.find((w) => String(w.project_id) === card.dataset.pid && w.name === card.dataset.name);
        if (item) openWork(item);
      };
    });
  } catch (e) {
    toast('作品库加载失败：' + e.message, 'err');
  }
}

function workCardHTML(w) {
  const q = w.quality || {};
  const dur = q.duration_s ? `${q.duration_s}s` : '';
  const date = fmtTime(w.latest_at);
  const cover = w.poster
    ? `<img src="${esc(w.poster.url)}" loading="lazy" alt="${esc(w.name)} 封面" />`
    : `<div class="wk-cover-fallback"><span>🎬</span><span>暂无封面</span></div>`;
  return `
      <article class="work-card" data-pid="${w.project_id ?? ''}" data-name="${esc(w.name)}" title="查看《${esc(w.name)}》详情">
        <div class="wk-cover">${cover}
          <span class="wk-dur">${esc(dur)}</span>
        </div>
        <div class="wk-info">
          <h3>《${esc(w.name)}》</h3>
          <div class="wk-meta">
            ${w.films.length > 1 ? `<span class="meta-tag">${w.films.length} 版成片</span>` : ''}
            ${q.shots ? `<span class="meta-tag">${q.shots} 镜</span>` : ''}
            ${q.narrated_shots ? `<span class="meta-tag">旁白 ${q.narrated_shots}/${q.shots}</span>` : ''}
            ${w.poster ? '<span class="meta-tag">有封面</span>' : ''}
          </div>
          <div class="wk-foot">${esc(date)}</div>
        </div>
      </article>`;
}

/** 作品详情弹窗：内嵌播放器（最新成片）+ 质检 + 全套下载 */
function openWork(w) {
  const latest = w.films[0];
  $('#wkTitle').textContent = `《${w.name}》`;
  const q = w.quality || {};
  const qf = qualityFlags(q);
  const qcls = (lvl) => (lvl ? ` ${lvl}` : '');
  const dlRowHtml = (label, file, icon) =>
    file
      ? `<a class="btn ghost sm" href="${esc(file.url)}" download title="${esc(file.name)}（${file.size_kb}KB）">${icon} ${label}</a>`
      : '';
  const filmDls = w.films
    .map(
      (f, i) =>
        `<a class="btn ghost sm" href="${esc(f.url)}" download title="${esc(f.name)}（${f.size_kb}KB）">⬇️ ${i === 0 ? '最新成片' : `成片 v${w.films.length - i}`}</a>`,
    )
    .join('');
  $('#wkBody').innerHTML = `
      <div class="wk-player"><video controls preload="metadata" id="wkVideo" src="${esc(latest.url)}"></video></div>
      <div class="wk-actions-row">
        ${filmDls}
        ${dlRowHtml('下载封面', w.poster, '🖼️')}
        ${w.subtitles.length ? `<a class="btn ghost sm" href="${esc(w.subtitles[0].url)}" download title="SRT 字幕">💬 字幕</a>` : ''}
        ${dlRowHtml('旁白台词', w.script, '📝')}
        <button class="btn ghost sm" id="wkCopyDir" title="复制作品目录路径，到资源管理器中打开">📁 复制目录路径</button>
      </div>
      ${
        q.duration_s
          ? `<div class="wk-quality">
        <span class="meta-tag${qcls(qf.overall)}">⏱ ${q.duration_s}s${q.duration_deviation_pct != null ? `（偏差 ${q.duration_deviation_pct > 0 ? '+' : ''}${q.duration_deviation_pct}%）` : ''}</span>
        ${q.loudness_lufs != null ? `<span class="meta-tag${qcls(qf.loud)}">🔊 ${q.loudness_lufs} LUFS</span>` : ''}
        ${q.shots ? `<span class="meta-tag">🎬 ${q.shots} 镜</span>` : ''}
        ${q.narrated_shots != null ? `<span class="meta-tag">🎙️ 旁白 ${q.narrated_shots}/${q.shots}</span>` : ''}
        ${q.sub_lines != null ? `<span class="meta-tag">💬 字幕 ${q.sub_lines} 行</span>` : ''}
      </div>`
          : ''
      }
      <div class="hint" style="margin-top:10px">本地目录：${esc(w.work_dir)}</div>`;
  $('#workModal').hidden = false;
  const copyBtn = $('#wkCopyDir');
  if (copyBtn)
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(w.work_dir);
        toast('目录路径已复制，可粘贴到资源管理器地址栏打开', 'ok');
      } catch {
        toast('复制失败，请手动复制：' + w.work_dir, 'warn');
      }
    };
}

/** 装配作品库视图交互（刷新按钮 + 播放最新成片按钮） */
function initWorks() {
  $('#worksRefresh').addEventListener('click', () => loadWorks());
  // 播放按钮：详情弹窗内视频播放/暂停切换
  $('#wkPlayLatest').addEventListener('click', () => {
    const v = $('#wkVideo');
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  });
}

export { loadWorks, initWorks };
