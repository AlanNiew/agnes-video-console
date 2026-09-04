// 前端入口：按依赖顺序加载模块。
// common / compare / state 为 ESM 模块；app / workspace 内部仍是 IIFE 视图——
// 跨视图通信经 state.js 事件总线，window.__* 代码引用已清零（B1 完成，B2 视图拆分进行中）。
import './common.js';
import './compare.js';
import './app.js';
import './workspace.js';
