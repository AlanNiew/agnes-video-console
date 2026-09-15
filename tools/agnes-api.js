'use strict';
/**
 * tools/agnes-api.js —— 创作驱动用 API 助手（Node ≥ 22，零依赖）
 * 用途：程序化驱动本平台创作（中文 JSON 请走此脚本，勿用 PowerShell curl —— 会乱码）。
 * 用法：const { api } = require('./agnes-api');  await api('POST', '/api/projects', {...});
 */
const BASE = process.env.AGNES_BASE || 'http://127.0.0.1:8273';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 500);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件满足（默认每 5s 一次） */
async function waitFor(fn, { timeoutMs = 600000, intervalMs = 5000, label = '条件' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}`);
}

module.exports = { api, sleep, waitFor, BASE };
