'use strict';
/**
 * eslint.config.js — flat config（ESLint 10）
 * 语法与可靠性检查为主，格式交给 prettier（经 eslint-config-prettier 关闭冲突规则）。
 */
const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  // 基础：推荐规则 + CommonJS 全局
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 既有代码中的防御性赋值/空 catch 容错模式：先降为警告，不在重构提交中混入行为变更
      'no-useless-assignment': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // 前端（public/ 全部为 ES module：入口/基础模块/视图装配；vite 无编译期类型检查，规则以可读性为主）
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // M4-B0：vite 构建配置（ESM）
    files: ['vite.config.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // e2e 冒烟测试：进程级脚本风格
    files: ['test/mock-e2e.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-process-exit': 'off' },
  },
  {
    // jest 单元测试：注入测试全局
    files: ['test/unit/**/*.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: { 'no-process-exit': 'off' },
  },
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**', 'dist/**'],
  },
];
