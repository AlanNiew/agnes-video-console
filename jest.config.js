'use strict';
/**
 * jest.config.js —— 单元测试配置
 * 只跑 test/unit/ 下的单测；进程内 e2e 冒烟（test/mock-e2e.js）保持独立脚本
 * `npm run test:mock`（它自建 mock 服务器并 require 整个应用，与 jest 沙箱不兼容）。
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/unit/**/*.test.js'],
  // db.js import 即开库：单测前把 DB/数据目录指到临时位置隔离副作用
  setupFiles: ['<rootDir>/test/unit/setup.js'],
  // 单测应快速失败，防止挂起拖垮 CI
  testTimeout: 15_000,
  verbose: true,
};
