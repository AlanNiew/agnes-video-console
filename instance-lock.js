'use strict';
/**
 * instance-lock.js —— 单实例工作锁（v1.6.1；M3 从 db.js 拆出）
 * 后台工作器（轮询/提交/图片/渲染/自动成片）全局只允许一个实例持有：
 * 多个控制台进程共用同一 SQLite 时，锁的持有者才运行工作器，其余实例仅提供 API——
 * 根治孤儿进程抢占任务队列。心跳 10s，锁过期判定 15s（持有者进程消亡后可被接管）。
 * 状态存于 settings 键 instance_lock（JSON {pid, heartbeat}）。
 */
const { db, settings } = require('./db');

const INSTANCE_LOCK_KEY = 'instance_lock';

// v1.9.2 原子 CAS（upsert 形式）：首次插入必成功；行已存在时仅当
// 「锁属本进程 / 心跳过期 / 坏数据」才覆盖——单条语句的语句级写锁保证跨进程原子性
// （tx/BEGIN IMMEDIATE 在 node:sqlite 跨进程实测不互斥，故弃用）。
// CASE 逐分支惰性求值：json_valid 守卫在前，坏 JSON 不会触达 json_extract 抛错。
const casStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CASE
      WHEN json_valid(settings.value) = 0 THEN 1
      WHEN CAST(json_extract(settings.value, '$.pid') AS INTEGER) = ? THEN 1
      WHEN json_extract(settings.value, '$.heartbeat') IS NULL THEN 1
      WHEN CAST(json_extract(settings.value, '$.heartbeat') AS INTEGER) < ? THEN 1
      ELSE 0
    END = 1
  `);

function getInstanceLock() {
  try {
    return JSON.parse(settings.get(INSTANCE_LOCK_KEY) || 'null');
  } catch {
    return null;
  }
}

/** 锁是否被「其他存活进程」持有（心跳过期视为无主） */
function instanceLockHeldByOther() {
  const l = getInstanceLock();
  if (!l || l.pid === process.pid) return false;
  if (Date.now() - (l.heartbeat || 0) > 15_000) return false;
  try {
    process.kill(l.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 尝试获取工作锁。v1.9.2 原子化：检查 + 写入压成单条 upsert CAS，
 * 消除双进程同时启动时「都通过检查 → 都写入 → 都拿到锁」的 TOCTOU 窗口。
 * 语义：心跳新鲜但持有进程实际已死时不再即时抢锁（旧版靠 kill(pid,0)），
 * 而是等心跳过期（≤15s）后由接管循环获得——收敛稍慢但避免 Windows pid 复用误判。 */
function acquireInstanceLock() {
  const r = casStmt.run(
    INSTANCE_LOCK_KEY,
    JSON.stringify({ pid: process.pid, heartbeat: Date.now() }),
    process.pid,
    Date.now() - 15_000, // 锁过期阈值（与 instanceLockHeldByOther 一致）
  );
  return r.changes > 0;
}

/** 持有者心跳；锁无主时顺带接管 */
function refreshInstanceLock() {
  if (!instanceLockHeldByOther()) {
    settings.set(INSTANCE_LOCK_KEY, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
  }
}

module.exports = { acquireInstanceLock, instanceLockHeldByOther, refreshInstanceLock };
