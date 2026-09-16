'use strict';
/**
 * render-stage.js —— 渲染进度的「阶段语义」（服务端与前端共用的单一来源）
 *
 * 进度分配（与 workers/render.js 一致）：
 *   1      = 准备素材（收集镜头/旁白/BGM）
 *   2–40   = 逐镜归一化
 *   40–95  = 合流与混音（xfade / 字幕 / 响度），由 ffmpeg -progress 回写
 *   95–100 = 收尾与归档（封面 / 发布文案 / 作品目录）
 *
 * 动机：此前进度停在 40% 时无法判断"在干什么、是不是卡死"（E03 事故复盘）。
 */
function renderStageLabel(progress, shotsTotal = 0) {
  const p = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  if (p >= 100) return '完成';
  if (p >= 95) return '收尾（封面与归档）';
  if (p > 40) return `合流与混音 ${Math.round(((p - 40) / 55) * 100)}%`;
  if (p >= 2) {
    const total = Number(shotsTotal) > 0 ? Math.round(Number(shotsTotal)) : 13;
    const raw = Math.round(((p - 2) / 38) * total);
    const done = Math.max(1, Math.min(total, raw || 1));
    return `逐镜归一化 ${done}/${total}`;
  }
  return '准备素材';
}

/** 给渲染任务行附加 stage_label（仅进行中的任务有值；列表与详情共用） */
function decorateRenderJob(job, shotsTotal = 0) {
  if (!job) return job;
  const active = job.status === 'queued' || job.status === 'rendering';
  return { ...job, stage_label: active ? renderStageLabel(job.progress, shotsTotal) : null };
}

module.exports = { renderStageLabel, decorateRenderJob };
