// 前端入口：按依赖顺序加载模块。
// common / compare / state / task-meta 为基础模块；app（装配层）会按序拉入
// settings-panel / new-task / works-panel / task-center，workspace 为创作工作台视图。
// 跨视图通信经 state.js 事件总线，window.__* 代码引用已清零（B1 完成；B2 任务中心按文件拆分已交付）。
import './common.js';
import './compare.js';
import './app.js';
import './workspace.js';
