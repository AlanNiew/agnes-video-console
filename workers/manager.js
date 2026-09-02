'use strict';
/**
 * workers/manager.js —— 后台 worker 管理器（M2 分层纪律）
 * 把「后台 worker 的启动/停止与唤醒驱动」从装配层与路由层收敛到这里：
 * - server.js 只 require 本管理器（不再逐个 start/stop 五个 worker）
 * - 路由层不接触 worker 实例细节（不 require poller / submitter / image-worker），
 *   只经本管理器发起领域动作（重载轮询间隔 / 重试唤醒 / 手动轮询）
 * auto 的「项目级编排」API（launch/stopProject/STAGE_META）仍由 routes/projects 直用——
 * 那是领域控制而非 worker 生命周期，不在此收敛；渲染的领域查询（hasFfmpeg/collectSegments）
 * 也仍由 routes/render 直用 workers/render。
 */
const poller = require('./poller');
const submitter = require('./submitter');
const imageWorker = require('./image-worker');
const renderer = require('./render');
const autoPipeline = require('./auto');

/** 启动全部后台 worker（各 worker 的 start 自带 stop→start，幂等） */
function startAll() {
  poller.start();
  submitter.start();
  imageWorker.start();
  renderer.start();
  autoPipeline.start();
}

/** 停止全部后台 worker（优雅退出用；各 stop 幂等） */
function stopAll() {
  autoPipeline.stop();
  renderer.stop();
  imageWorker.stop();
  submitter.stop();
  poller.stop();
}

/** 设置变更后重载轮询器：变更了 poll_interval_ms 或轮询器尚未运行时启动它 */
function syncPoller(changed = []) {
  if (changed.includes('poll_interval_ms') || !poller.timer) poller.start();
}

/** 任务重试/新入队后立即唤醒对应 worker 处理（提交器或图片工作器按其类型接管） */
function kickTask(taskId) {
  submitter.kick(taskId);
  imageWorker.kick(taskId);
}

/** 手动强制轮询单个任务（返回任务最新行，交给 poller 判定） */
function pollNow(taskId) {
  return poller.pollNow(taskId);
}

module.exports = { startAll, stopAll, syncPoller, kickTask, pollNow };
