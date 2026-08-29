/* compare.js —— 新旧内容对比弹窗（任务中心 / 创作工作台共用，无依赖） */
(() => {
  'use strict';

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * 弹出「旧版 vs 新版」对比窗，由用户二选一
   * @param {object} o
   * @param {string} o.title       弹窗标题
   * @param {string} [o.oldLabel]  左栏标题（默认「当前版本」）
   * @param {string} [o.newLabel]  右栏标题（默认「新版本」）
   * @param {*} o.oldText          旧内容（结构由 renderText 解释）
   * @param {*} o.newText          新内容
   * @param {Function} [o.renderText] 自定义渲染（收到内容，返回 HTML）；默认按换行分段 + 转义
   * @param {Function} o.onAdopt   采用新版（关窗后调用）
   * @param {Function} [o.onKeep]  保留当前（关窗后调用）
   */
  function compare(o) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const renderText = o.renderText
      || ((t) => String(t ?? '').split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join(''));
    overlay.innerHTML = `
      <div class="modal wide compare-modal">
        <div class="modal-head"><h2>${esc(o.title || '对比新旧版本')}</h2><button class="modal-close">✕</button></div>
        <div class="modal-body compare-body">
          <div class="compare-col">
            <div class="compare-col-head">${esc(o.oldLabel || '当前版本')}</div>
            <div class="compare-text">${renderText(o.oldText) || '<p class="muted">（空）</p>'}</div>
          </div>
          <div class="compare-col compare-col-new">
            <div class="compare-col-head">${esc(o.newLabel || '新版本')}</div>
            <div class="compare-text">${renderText(o.newText) || '<p class="muted">（空）</p>'}</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-keep>保留当前版本</button>
          <button class="btn primary" data-adopt>采用新版本</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.modal-close')) { close(); o.onKeep?.(); return; }
      if (e.target.closest('[data-adopt]')) { close(); o.onAdopt?.(); return; }
      if (e.target.closest('[data-keep]')) { close(); o.onKeep?.(); }
    });
  }

  window.__ui = { compare };
})();
