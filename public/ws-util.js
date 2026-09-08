/* ws-util.js —— 创作工作台共享小工具（M4-B3-4：自 workspace.js 拆出）
 * sleep / stageHints（分阶段等待提示）/ 各动作的阶段提示文案常量，供各步骤动作模块复用。
 * stageHints 仅操作文档上的 .ws-loading-text 节点，无会话状态。
 */
/** 分阶段等待提示：每秒检查耗时，把 .ws-loading-text 换成对应阶段文案；返回停止函数 */
function stageHints(selectors, stages) {
  const start = Date.now();
  const timer = setInterval(() => {
    const el = selectors.map((s) => document.querySelector(s)).find(Boolean);
    if (!el) return;
    const sec = (Date.now() - start) / 1000;
    let text = stages[0][1];
    for (const [from, msg] of stages) if (sec >= from) text = msg;
    el.textContent = text;
  }, 1000);
  return () => clearInterval(timer);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STAGES_SCRIPT = [
  [0, '正在分析创意，梳理故事结构…'],
  [8, '正在撰写梗概与角色设定…'],
  [18, '即将完成，正在润色提示词…'],
];
const STAGES_STORY = [
  [0, '正在拆解叙事节奏…'],
  [8, '正在设计镜头与运镜…'],
  [18, '即将完成，正在对齐镜头衔接…'],
];
const STAGES_IMG = [
  [0, '正在生成候选图（约 10–90 秒），完成后在下方挑选…'],
  [30, '模型仍在绘制，请稍候…'],
  [60, '复杂画风耗时较长，马上好…'],
];

export { stageHints, sleep, STAGES_SCRIPT, STAGES_STORY, STAGES_IMG };
