import { defineConfig } from 'vite';

// 前端构建（M4-B0）：root 指向 public/（index.html 即入口），产物输出到 dist/。
// 视图模块保持经典 IIFE + window.__* 互调（行为等价阶段），main.js 按序 import。
export default defineConfig({
  root: 'public',
  base: '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2022',
  },
});
