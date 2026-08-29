'use strict';
/**
 * pipeline.js —— 创作流水线服务层（M2）
 * 把「角色定稿图 + 视频提示词 → 2.5-flash reference 请求 → 任务入队」的编排
 * 从路由中抽出，供旧版整项目提交与 M2 单镜头提交复用。
 * 依赖由 server.js 注入（避免循环 require）。
 */

function createPipelineService(deps) {
  const { projects, buildPayload, submitTask, ApiError, log } = deps;

  /**
   * 组装并提交一条项目/镜头视频任务
   * @param {object} o
   * @param {number} o.projectId   项目 id
   * @param {string} o.prompt      视频提示词（允许为空串，由调用方先做回退解析）
   * @param {string} [o.seconds]   覆盖时长（默认继承项目）
   * @param {string} [o.aspectRatio] 覆盖画幅（默认继承项目）
   * @param {number|null} [o.shotId] 镜头溯源（M2）
   * @returns {object} 新建任务行
   */
  async function submitVideoTask({ projectId, prompt, seconds, aspectRatio, shotId = null }) {
    const p = projects.get(projectId);
    if (!p) throw new ApiError(404, '项目不存在');
    const charImg = projects.selectedImage(p.id, 'character');
    if (!charImg || !charImg.remote_url) {
      throw new ApiError(400, '请先完成「角色设定」并定稿一张角色图');
    }
    const text = String(prompt || '').trim();
    if (!text) throw new ApiError(400, '缺少视频提示词（请先生成或手动输入）');
    // 提示词中必须引用角色图，显式保持外观一致
    const finalPrompt = text.includes('<Picture 1>')
      ? text
      : `以 <Picture 1> 中的角色为参考，保持其外观一致。${text}`;
    const { payload, meta } = buildPayload({
      model: 'agnes-video-2.5-flash',
      prompt: finalPrompt,
      mode: 'reference',
      seconds: String(seconds || p.seconds || '5'),
      size: '720P',
      aspect_ratio: String(aspectRatio || p.aspect_ratio || '16:9'),
      images: [charImg.remote_url],
    });
    const task = await submitTask(payload, meta, {
      project_id: p.id,
      shot_id: shotId,
      image_id: charImg.id,
    });
    log('info', `项目 #${p.id} 发起视频任务 #${task.id}${shotId ? `（镜头 #${shotId}）` : ''}（引用角色图 #${charImg.id}）`);
    return task;
  }

  return { submitVideoTask };
}

module.exports = { createPipelineService };
