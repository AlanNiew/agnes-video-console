'use strict';
/**
 * errors.js —— 统一业务错误协议（v1.9.1 重构）
 * 原状态：三套错误约定并存——
 *   1) ApiError（server.js 内定义，约 90+ 处抛出）
 *   2) 裸 Error + expose/status 附加属性（netmusic.js 一处）
 *   3) {ok, status} 结果对象不抛错（agnes.js / fish-tts.js 客户端，保留不动——
 *      它们是「调用方自行翻译」的客户端风格，适合远程调用的部分失败语义）
 * 本文件把 1) 与 2) 收敛为一套：ApiError + 可选 expose 标记。
 * 错误中间件统一挂载点见 server.js（expose 协议兼容保留，过渡期不破坏）。
 */

/** 业务错误：带 HTTP 状态码；expose=true 时错误中间件直接透传消息给前端 */
class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 错误消息
   * @param {{expose?: boolean}} [options] expose：允许消息透传给客户端（默认 true——
   *        历史行为即如此：所有 ApiError 消息均面向用户可读）
   */
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.expose = options.expose !== false;
  }
}

/** 异步路由包装器：把 Promise rejection 送入 Express 错误中间件 */
function ah(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { ApiError, ah };
