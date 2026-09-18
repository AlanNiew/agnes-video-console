'use strict';
const { portraitLayout } = require('../../workers/render');

describe('竖屏合成布局（v2.6.3 方案 A）', () => {
  test('默认 720×1280：底部安全区 = 高 15%，模糊 sigma = 短边 3%', () => {
    expect(portraitLayout()).toEqual({ w: 720, h: 1280, sigma: 22, marginV: 192 });
  });

  test('自定义尺寸按同一比例推导', () => {
    expect(portraitLayout({ w: 1080, h: 1920 })).toEqual({ w: 1080, h: 1920, sigma: 32, marginV: 288 });
  });

  test('极小尺寸下 sigma 有下限 8（避免模糊不可见）', () => {
    expect(portraitLayout({ w: 100, h: 200 }).sigma).toBe(8);
  });

  test('底部安全区随高度线性变化（手机 UI 安全区随画布高度缩放）', () => {
    const a = portraitLayout({ w: 720, h: 1280 }).marginV;
    const b = portraitLayout({ w: 720, h: 2560 }).marginV;
    expect(b).toBe(a * 2);
  });
});
