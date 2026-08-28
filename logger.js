'use strict';
/**
 * logger.js —— 极简内存日志（环形缓冲），供 UI 的“日志”面板使用
 */
const RING_SIZE = 300;
const ring = [];

function log(level, msg) {
  const entry = { ts: Date.now(), level, msg: String(msg) };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  const line = `[${new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })}] [${level}] ${entry.msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  return entry;
}

function recent(n = 100) {
  return ring.slice(-n);
}

module.exports = { log, recent };