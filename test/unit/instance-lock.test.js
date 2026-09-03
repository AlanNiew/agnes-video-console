'use strict';
/**
 * 单实例锁原子 CAS 单元测试（v1.9.2）
 * 语义：首次插入成功；同 pid 重入成功；其他 pid 心跳新鲜 → 抢不到；
 * 心跳过期 / 坏数据 → 可接管。跨进程原子性由并发脚本验证（见 CHANGELOG v1.9.2）。
 */
const { db, settings } = require('../../db');
const { acquireInstanceLock } = require('../../instance-lock');

const LOCK_KEY = 'instance_lock';

describe('acquireInstanceLock（upsert CAS）', () => {
  test('首次获取（无锁行）成功', () => {
    db.exec(`DELETE FROM settings WHERE key = '${LOCK_KEY}'`); // 模拟初始状态
    expect(acquireInstanceLock()).toBe(true);
  });

  test('同进程重入成功（pid 相等分支）', () => {
    settings.set(LOCK_KEY, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
    expect(acquireInstanceLock()).toBe(true);
  });

  test('其他 pid 持有且心跳新鲜 → 获取失败（TOCTOU 防线）', () => {
    settings.set(LOCK_KEY, JSON.stringify({ pid: 999999, heartbeat: Date.now() }));
    expect(acquireInstanceLock()).toBe(false);
    // 且不覆盖持有者的锁
    expect(JSON.parse(settings.get(LOCK_KEY)).pid).toBe(999999);
  });

  test('心跳过期（>15s）→ 可接管', () => {
    settings.set(LOCK_KEY, JSON.stringify({ pid: 999999, heartbeat: Date.now() - 20_000 }));
    expect(acquireInstanceLock()).toBe(true);
    expect(JSON.parse(settings.get(LOCK_KEY)).pid).toBe(process.pid);
  });

  test('坏 JSON 锁数据 → 可接管（heartbeat IS NULL 分支）', () => {
    settings.set(LOCK_KEY, 'not-a-json');
    expect(acquireInstanceLock()).toBe(true);
  });
});
