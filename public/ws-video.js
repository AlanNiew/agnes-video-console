/* ws-video.js —— 创作工作台第④步：镜头视频提交动作（M4-B3-4：自 workspace.js 拆出）
 * 单镜提交 submitShot / 批量提交未完成镜头 runBatchSubmit / 旧单任务提交 submitVideo。
 * 状态（batchBusy/Stop/Hint）读共享 st；动作后的整页重刷统一广播 bus 'ws-project-changed'
 * 由装配层（workspace.js）判断当前项目再 renderProject（杜绝 import 环）。
 * 依赖：common.js、state.js、ws-state.js（st）、ws-util.js（sleep）、ws-render.js（shotLatestTask）。
 */
import { $, toast, api } from './common.js';
import { bus } from './state.js';
import { st } from './ws-state.js';
import { sleep } from './ws-util.js';
import { shotLatestTask } from './ws-render.js';

async function submitShot(projectId, shotId) {
  const btn = document.querySelector(`[data-shot-submit="${shotId}"]`);
  if (!btn || btn.disabled) return; // 防连点重复提交
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const r = await api(`/api/projects/${projectId}/shots/${shotId}/videos`, { method: 'POST', body: {} });
    toast(`镜头任务 #${r.id} 已入队（后台提交器将按间隔自动提交）`, 'ok');
    bus.emit('tasks-changed');
    bus.emit('ws-project-changed', projectId);
  } catch (e) {
    toast('提交失败：' + e.message, 'err');
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = '🚀 提交';
    }
  }
}

/** 批量提交「未完成」镜头（无任务或最新任务失败），按 submit_interval_ms 节流 */
async function runBatchSubmit(projectId) {
  if (st.batchBusy) return;
  let targets;
  try {
    const d = await api(`/api/projects/${projectId}`);
    const shots = d.shots || [];
    targets = shots.filter((s) => {
      const t = shotLatestTask(d.tasks || [], s.id);
      return !t || t.status === 'failed' || t.status === 'submit_error';
    });
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  if (!targets.length) {
    toast('所有镜头都已有进行中或已完成的任务', 'ok');
    return;
  }
  // M4-B1-4：直接取后端设置（不再读 app 的 getSettings 缓存）
  let interval = 60000;
  try {
    const s = await api('/api/settings');
    interval = Math.max(0, Number(s?.submit_interval_ms ?? 60000) || 0);
  } catch {
    /* 取不到设置时按默认 60s */
  }
  if (!confirm(`将按间隔 ${Math.round(interval / 1000)} 秒依次提交 ${targets.length} 个镜头的视频任务，继续？`)) return;
  st.batchBusy = true;
  st.batchStop = false;
  st.batchHint = '准备提交…';
  bus.emit('ws-project-changed', projectId); // 装配层重绘 →「批量提交中…」+ 停止按钮
  let done = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    if (st.batchStop) break;
    const hintEl = () => {
      const el = $('#wsBatchHint');
      if (el) el.textContent = st.batchHint;
    };
    st.batchHint = `正在提交镜头 ${s.seq}（${i + 1}/${targets.length}）…`;
    hintEl();
    try {
      await api(`/api/projects/${projectId}/shots/${s.id}/videos`, { method: 'POST', body: {} });
      done += 1;
    } catch (e) {
      fail += 1;
      toast(`镜头 ${s.seq} 提交失败：${e.message}`, 'err');
    }
    // 倒计时等待（每秒检查停止标记）
    const last = i === targets.length - 1;
    if (interval > 0 && !last) {
      for (let w = Math.round(interval / 1000); w > 0 && !st.batchStop; w--) {
        st.batchHint = `镜头 ${s.seq} 已提交，${w}s 后提交下一个（${i + 1}/${targets.length}）…`;
        hintEl();
        await sleep(1000);
      }
    }
  }
  st.batchBusy = false;
  st.batchHint = `批量提交结束：成功 ${done}${fail ? `，失败 ${fail}` : ''}${st.batchStop ? '（已手动停止）' : ''}`;
  toast(st.batchHint, fail ? 'warn' : 'ok');
  bus.emit('tasks-changed');
  bus.emit('ws-project-changed', projectId);
}

async function submitVideo(projectId) {
  const btn = $('#wsSubmitVideo');
  if (!btn || btn.disabled) return; // 防连点重复提交（每次提交都真实占用生成额度）
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const r = await api(`/api/projects/${projectId}/videos`, {
      method: 'POST',
      body: { seconds: $('#wsVSeconds').value, aspect_ratio: $('#wsVAspect').value },
    });
    toast(`视频任务 #${r.id} 已提交，可在任务中心跟踪`, 'ok');
    $('#navTasks')?.click();
    setTimeout(() => bus.emit('tasks-changed'), 300);
  } catch (e) {
    toast('提交失败：' + e.message, 'err');
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = '🚀 提交视频任务';
    }
  }
}

export { submitShot, runBatchSubmit, submitVideo };
