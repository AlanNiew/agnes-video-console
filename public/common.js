/* common.js —— 前端公共工具（M4-B1-1：正式 ESM 模块化）
 * 依赖：无。作为 ES module 先于 compare.js / app.js / workspace.js 求值（见 main.js 顺序 import）。
 * 说明：本模块同时 export 纯函数并注入 window.__common 兼容层——compare/app/workspace
 * 目前仍是经典 IIFE（在 evaluate 阶段解构 window.__common），待 B2/B3 逐个改为 import 后删除注入。
 */
/** DOM 查询快捷方式 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** HTML 转义（插值进 innerHTML 前必须调用） */
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

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
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
};

/* ---------------- v2.2 主题管理（深色 / 浅色 / 跟随系统） ----------------
 * 真实主题落 <html data-theme="dark|light">（'system' 仅是用户选择，
 * 应用时按 prefers-color-scheme 解析）；index.html head 内联脚本已做首屏防闪烁。
 * 按钮自包含绑定：common.js 在 body 末尾加载，DOM 已就绪。 */
const THEMES = ['dark', 'light', 'system'];
const THEME_META = {
  dark: { icon: '🌙', label: '深色' },
  light: { icon: '☀️', label: '浅色' },
  system: { icon: '🖥️', label: '跟随系统' },
};
const THEME_KEY = 'agnes-theme';

const getTheme = () => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'dark';
  } catch {
    return 'dark';
  }
};
const systemPrefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
/** 把用户选择解析为真实主题并应用到 <html>；同步切换按钮图标与提示 */
const applyTheme = (mode) => {
  const real = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = real;
  const btn = $('#btnTheme');
  if (btn) {
    const meta = THEME_META[mode] || THEME_META.dark;
    btn.textContent = meta.icon;
    btn.title = `当前主题：${meta.label}（点击切换 深色 → 浅色 → 跟随系统）`;
  }
};
const setTheme = (mode) => {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* 隐私模式下不可持久化，仅本次会话生效 */
  }
  applyTheme(mode);
};
const cycleTheme = () => {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  setTheme(next);
  return next;
};
// system 模式下系统切换深浅时实时跟随
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (getTheme() === 'system') applyTheme('system');
});
// 绑定切换按钮 + 按当前选择刷新按钮展示
(() => {
  const btn = $('#btnTheme');
  if (btn) btn.addEventListener('click', () => toast(`已切换主题：${THEME_META[cycleTheme()].label}`, 'ok'));
  applyTheme(getTheme());
})();

const theme = { getTheme, setTheme, cycleTheme, applyTheme };

// M4-B1-1 兼容注入：旧 IIFE（compare/app/workspace）在 evaluate 阶段仍从 window.__common 解构
window.__common = { $, $$, esc, fmtTime, toast, api, theme };

export { $, $$, esc, fmtTime, toast, api, theme };
