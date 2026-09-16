'use strict';
/** 渲染阶段文案（v2.5.1）：进度 → 人话，避免"停在 40% 不知道在干嘛" */
const { renderStageLabel, decorateRenderJob } = require('../../lib/render-stage');

describe('renderStageLabel（进度 → 阶段文案）', () => {
  test('准备与收尾边界', () => {
    expect(renderStageLabel(0)).toBe('准备素材');
    expect(renderStageLabel(1)).toBe('准备素材');
    expect(renderStageLabel(95)).toBe('收尾（封面与归档）');
    expect(renderStageLabel(99)).toBe('收尾（封面与归档）');
    expect(renderStageLabel(100)).toBe('完成');
  });

  test('逐镜归一化：按总镜数换算（40% 时恰好全部完成）', () => {
    expect(renderStageLabel(2, 13)).toBe('逐镜归一化 1/13');
    expect(renderStageLabel(21, 13)).toBe('逐镜归一化 7/13');
    expect(renderStageLabel(40, 13)).toBe('逐镜归一化 13/13');
    expect(renderStageLabel(21, 0)).toBe('逐镜归一化 7/13'); // 缺省按 13 镜
  });

  test('合流与混音：40–95 区间按百分比换算', () => {
    expect(renderStageLabel(41, 13)).toMatch(/^合流与混音 \d+%$/);
    expect(renderStageLabel(95 - 1, 13)).toMatch(/^合流与混音 9\d%$/);
  });

  test('越界输入夹紧，不抛异常', () => {
    expect(renderStageLabel(-5)).toBe('准备素材');
    expect(renderStageLabel(999)).toBe('完成');
    expect(renderStageLabel(null)).toBe('准备素材');
  });
});

describe('decorateRenderJob（仅进行中任务带 stage_label）', () => {
  test('渲染中 → 带阶段文案；已完成 → null', () => {
    expect(decorateRenderJob({ id: 1, status: 'rendering', progress: 21 }, 13).stage_label).toBe('逐镜归一化 7/13');
    expect(decorateRenderJob({ id: 2, status: 'queued', progress: 0 }, 13).stage_label).toBe('准备素材');
    expect(decorateRenderJob({ id: 3, status: 'completed', progress: 100 }, 13).stage_label).toBe(null);
    expect(decorateRenderJob(null)).toBe(null);
  });
});
