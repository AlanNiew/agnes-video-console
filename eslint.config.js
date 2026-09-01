'use strict';
/**
 * eslint.config.js —— flat config（ESLint 10）
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
      // 本项目浏览器脚本挂在 window.__common 等命名空间上，属有意设计
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 既有代码中的防御性赋值/空 catch 容错模式：先降为警告，不在重构提交中混入行为变更
      'no-useless-assignment': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // 前端浏览器脚本（无构建步骤，经典 script 标签加载）
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        __common: 'readonly',
        __ui: 'readonly',
        __app: 'readonly',
        __ws: 'readonly',
        __audio: 'readonly',
      },
    },
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
    ignores: ['node_modules/**', 'data/**', 'coverage/**'],
  },
];
