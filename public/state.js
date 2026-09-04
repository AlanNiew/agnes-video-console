/* state.js —— M4-B1-3 前端轻量事件总线（视图间通信，渐进替代 window.__* 直接互调）
 * 用法：视图改动他人数据后 bus.emit('事件')，关心者 bus.on('事件', fn) 自己刷新自己，
 * 不再反向调用对方 window 实例。事件约定见 docs/FRONTEND_REFACTOR_PLAN.md。
 */
const listeners = new Map(); // event -> Set<fn>

/** 订阅事件；返回取消订阅函数 */
function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => off(event, fn);
}

/** 取消订阅 */
function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

/** 广播事件（监听器异常隔离：一个出错不打断其它监听） */
function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[state] 监听器异常（${event}）:`, e);
    }
  }
}

const bus = { on, off, emit };

export { bus, on, off, emit };
export default bus;
