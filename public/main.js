// 前端入口（M4-B0）：按依赖顺序加载既有视图模块。
// common → compare → app → workspace：顺序 import 保证求值先后（各文件内部仍是
// IIFE + window.__*，本阶段保持行为等价；B1+ 再逐步 ESM 化并消除全局互调）。
import './common.js';
import './compare.js';
import './app.js';
import './workspace.js';
