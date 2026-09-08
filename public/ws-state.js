/* ws-state.js —— 创作工作台共享会话状态（M4-B3-3：自 workspace.js 拆出的可变单例）
 * workspace.js（装配）与各步骤动作模块（分镜/角色/视频/文案等）经此对象读写
 * 会话级状态：当前项目、生成 busy 标记、镜头缓存、批量提交进度、步骤/配方选中。
 * 可变单例字段（不换绑定），模块 import { st } 后读写 st.xxx 即可跨模块共享。
 */
export const st = {
  currentProjectId: null,
  imgGenBusy: false,
  scriptBusy: false,
  storyBusy: false, // M2：分镜生成中
  currentShotCount: 0, // M2：当前项目镜头数（供重生成确认判断）
  projectsShotsCache: null, // P3：当前项目 shots 缓存（审查报告采纳时按 seq 找镜头 id）
  batchBusy: false, // M2：批量提交进行中
  batchStop: false, // M2：批量提交停止标记
  batchHint: '', // M2：批量提交进度提示
  currentStep: 1, // 当前视区所在步骤（步骤条高亮跟随）
  wsFilmPresetId: '', // 当前选中渲染配方预设（手动改参数后清空 = 自定义配方）
};
