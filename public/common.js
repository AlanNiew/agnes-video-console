/* common.js —— 前端公共工具（v1.9.1：消除 app.js / workspace.js / compare.js 三重拷贝）
 * 依赖：无。须在 compare.js / app.js / workspace.js 之前加载（见 index.html）。
 * 注意：挂到 window.__common 而非全局变量，避免隐式全局；各模块顶部解构使用。
 */
(() => {
  'use strict';

  /** DOM 查询快捷方式 */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** HTML 转义（插值进 innerHTML 前必须调用） */
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** 时间戳 → 'YYYY-MM-DD HH:mm' */
  const fmtTime = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /** 轻量提示条（index.html 需有 #toasts 容器） */
  const toast = (msg, type = '') => {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  /**
   * fetch API 封装：JSON 请求 + 统一错误
   * 错误对象带 err.status（HTTP 状态码），供调用方按状态分流
   */
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };

  window.__common = { $, $$, esc, fmtTime, toast, api };
})();
