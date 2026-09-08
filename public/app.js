/* Agnes Video 任务控制台 —— 前端装配层（M4-B2：视图域拆为独立模块后，本文件仅剩顶层编排）
 * 职责：主视图切换（创作工作台 / 我的作品 / 任务中心）、全局轮询、日志弹窗、弹窗通用关闭，
 *       以及模块初始化与数据首载的编排。子视图逻辑见：
 *   task-meta.js（模型元数据）· settings-panel.js（设置）· new-task.js（新建任务）
 *   works-panel.js（作品库）· task-center.js（任务中心）· workspace.js（创作工作台）
 */
import { $, $$, fmtTime, api } from './common.js';
import { bus } from './state.js';
import { loadMeta } from './task-meta.js';
import { loadSettings, initSettings } from './settings-panel.js';
import { initNewTask } from './new-task.js';
import { loadWorks, initWorks } from './works-panel.js';
import { loadTasks, refreshDetail, getViewMode, initTaskCenter } from './task-center.js';

/* ---------------- 日志 ---------------- */
async function refreshLogs() {
  try {
    const { items } = await api('/api/logs');
    $('#logBox').textContent = items.map((l) => `[${fmtTime(l.ts)}] [${l.level}] ${l.msg}`).join('\n');
  } catch {
    /* ignore */
  }
}

/* ---------------- 弹窗通用 ---------------- */
function bindModals() {
  $$('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.hidden = true; // 点遮罩关闭
    });
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) ov.hidden = true;
    });
  });
  // v2.2.2：全站弹窗支持 Esc 关闭——复用每个弹窗自己的关闭控件语义
  // （静态 modal 经 data-close 收起；compare/新建项目等动态 overlay 的 modal-close/data-close
  //  由其自带监听处理「保留/取消」等后续逻辑，因此这里只派发 click 而不是直接置 hidden）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const stack = [...document.querySelectorAll('.modal-overlay')].filter((ov) => !ov.hidden);
    const top = stack[stack.length - 1]; // 栈顶 = 最后打开的（后 append 的遮罩层级最高）
    if (!top) return;
    const closer = top.querySelector('[data-close], .modal-close');
    if (closer) closer.click();
    else top.hidden = true;
  });
}

/* ---------------- 刷新循环 ---------------- */
let loopBusy = false; // 防止上一轮请求未完成时堆叠（慢网络下旧响应覆盖新响应）
let lastWsTasksRefresh = 0;
function startLoop() {
  setInterval(async () => {
    if (document.hidden || loopBusy) return; // 后台标签页不刷新
    loopBusy = true;
    try {
      await loadTasks();
      await refreshDetail(); // detailId 未打开时内部直接返回
      if (!$('#logModal').hidden) await refreshLogs();
      // 工作台第④步任务进度低频自动更新（10s，独立于整页重绘，不打断编辑）
      if (!$('#workspaceView').hidden && Date.now() - lastWsTasksRefresh > 10000) {
        lastWsTasksRefresh = Date.now();
        bus.emit('ws-task-progress'); // M4-B1-4：经事件让工作台自刷新镜头任务进度
      }
    } catch {
      /* ignore */
    } finally {
      loopBusy = false;
    }
  }, 2000);
}

/* ---------------- 初始化 ---------------- */
async function init() {
  // 各视图模块一次性绑定（内部数据加载不在此处，见下方首载编排）
  initNewTask();
  initSettings();
  initWorks();
  initTaskCenter();

  // 主视图切换：创作工作台 / 我的作品 / 任务中心
  function switchView(v) {
    const ws = v === 'workspace';
    const wk = v === 'works';
    $('#navWorkspace').classList.toggle('active', ws);
    $('#navWorks').classList.toggle('active', wk);
    $('#navTasks').classList.toggle('active', !ws && !wk);
    $('#workspaceView').hidden = !ws;
    $('#worksView').hidden = !wk;
    // v2.2.2：顶栏完全常驻（统计栏/新建任务任何视图都不隐藏）——只有任务中心专属的
    // 搜索筛选工具栏与空态提示随视图切换；统计栏数据本就全局有效（任务池不分视图）
    const taskHidden = ws || wk;
    ['.toolbar', '#emptyTip'].forEach((sel) => {
      const el = $(sel);
      if (el) el.hidden = taskHidden;
    });
    // 任务中心内部视图（列表/看板）恢复用户所选模式，避免两个容器同时显示
    $('#taskListView').hidden = taskHidden || getViewMode() !== 'list';
    $('#board').hidden = taskHidden || getViewMode() !== 'board';
    if (ws) bus.emit('workspace-shown'); // M4-B1-4：进入工作台视图时经事件让工作台自刷新
    if (wk) loadWorks();
  }
  $('#navWorkspace').addEventListener('click', () => switchView('workspace'));
  $('#navWorks').addEventListener('click', () => switchView('works'));
  $('#navTasks').addEventListener('click', () => switchView('tasks'));
  $('#btnLogs').addEventListener('click', () => {
    $('#logModal').hidden = false;
    refreshLogs();
  });
  bindModals();

  // 首载（M4-B1：视图互调已事件化，不再经 window.__app 暴露）
  await loadMeta();
  await loadSettings();
  await loadTasks();
  startLoop();
  // v2.2.2：默认落在第一个 tab「创作工作台」（新手从创作入口开始；任务中心统计仍在顶栏常驻可见）
  switchView('workspace');
}

document.addEventListener('DOMContentLoaded', init);
