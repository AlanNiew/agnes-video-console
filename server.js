'use strict';
/**
 * server.js —— Agnes Video 任务控制台 服务端入口（v1.9.1 分层重构后仅保留装配职责）
 * Express 装配 + 静态服务 + 统一错误中间件 + 启动编排（单实例工作锁 / 优雅退出）。
 *
 * 分层结构（详见 README「项目结构」）：
 *   constants.js          常量（模型清单 / 参数白名单 / 上限 / TTS 预设）
 *   config.js             跨模块共享常量与工具（DEFAULT_BASE_URL / probeDuration / 渲染默认参数）
 *   errors.js             ApiError + ah（统一业务错误协议）
 *   services/             纯校验与组装（payloads / prompts / voice-pool）+ pipeline（依赖注入）
 *   routes/               按领域拆分的 API 路由（54 条，注册顺序与拆分前一致）
 *   db / agnes / submitter / poller / render / netmusic / fish-tts / artifacts / logger / openapi
 */
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { settings, DB_PATH, acquireInstanceLock, refreshInstanceLock, DEFAULT_SETTINGS } = require('./db');
const poller = require('./poller');
const submitter = require('./submitter');
const imageWorker = require('./image-worker');
const renderer = require('./render');
const autoPipeline = require('./auto');
const { ARTIFACTS_DIR } = require('./artifacts');
const { log } = require('./logger');
const { ApiError } = require('./errors');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------------- 路由装配（注册顺序 = 拆分前的原始顺序，行为不变） ---------------- */
require('./routes/meta')(app); // /api/meta /api/health /api/openapi.json /api/logs
require('./routes/settings')(app); // GET/PUT /api/settings
require('./routes/tasks')(app); // /api/stats /api/tasks*（创建/重试/轮询/删除/批量）
require('./routes/llm')(app); // /api/llm/chat /script /storyboard
require('./routes/images')(app); // /api/images/generate /api/images/:id
require('./routes/tts')(app); // /api/tts/*（voices/pool/market/generate/select/bind）
require('./routes/music')(app); // /api/music/* + /api/projects/:id/bgm
require('./routes/projects')(app); // /api/projects*（文案/图片/镜头/视频任务/重拍/定稿）
require('./routes/render')(app); // /api/projects/:id/render + /api/render/jobs*

/* ---------------- 本地图片静态服务 ---------------- */
try {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
} catch {
  /* ignore */
}
app.use('/artifacts', express.static(ARTIFACTS_DIR, { maxAge: '7d' }));

/* ---------------- 静态前端 ---------------- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- 错误处理 ---------------- */
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err); // 响应已开始流式输出时交给 Express 默认处理
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  // 兼容兜底：显式标记 expose 的裸错误（历史协议，新代码请统一用 ApiError）
  if (err.expose === true && Number.isInteger(err.status)) {
    log('error', `可暴露错误（${err.status}）: ${err.message}`);
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON' });
  log('error', `未处理异常: ${err.message}\n${err.stack || ''}`);
  res.status(500).json({ error: '服务器内部错误（详情见「日志」面板）' });
});

/* ---------------- 启动 ---------------- */
const PORT = Number(process.env.PORT) || 8273;

// 确保默认设置存在
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (settings.get(k) === null) settings.set(k, v);
}

// v1.6.1 单实例工作锁：后台工作器（轮询/提交/渲染）全局只允许一份。
// 拿到锁的实例运行工作器；未拿到的仅提供 API，并每 30s 尝试接管（持有者消亡后锁 15s 过期）。
function startWorkers() {
  poller.start();
  submitter.start();
  imageWorker.start();
  renderer.start();
  autoPipeline.start();
}
if (acquireInstanceLock()) {
  startWorkers();
} else {
  log('warn', '检测到另一实例持有工作锁，本实例仅提供 API，后台工作器停用（每 30s 尝试接管）');
  const takeover = setInterval(() => {
    if (acquireInstanceLock()) {
      startWorkers();
      log('info', '工作锁已接管，后台工作器启动');
      clearInterval(takeover);
    }
  }, 30_000);
  takeover.unref?.();
}
setInterval(() => refreshInstanceLock(), 10_000).unref?.();
// 只监听本机回环地址：本地单机工具，不对局域网/公网开放（API Key 存于本地）
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║        Agnes Video 任务控制台 已启动                ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  ➜ 打开:  http://127.0.0.1:${PORT}`);
  console.log(`  ➜ 数据库: ${DB_PATH}`);
  console.log(`  ➜ 默认模型: ${settings.get('model')}（当前限时免费）`);
  console.log('  提示: 请先在页面右上角“设置”中填写你的 Agnes API Key');
  console.log('');
});

function shutdown(signal) {
  log('info', `收到 ${signal}，正在关闭...`);
  poller.stop();
  imageWorker.stop();
  autoPipeline.stop();
  server.close(() => {
    require('./db').db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 常驻轮询服务的进程级兜底：遗漏的 rejection 记日志不崩；uncaughtException 走优雅退出
process.on('unhandledRejection', (reason) => {
  log(
    'error',
    `未处理的 Promise rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
  );
});
process.on('uncaughtException', (err) => {
  log('error', `未捕获异常，进程即将退出: ${err.stack || err.message}`);
  shutdown('uncaughtException');
});

module.exports = { app, server }; // 供冒烟测试使用
