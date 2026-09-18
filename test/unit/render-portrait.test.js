'use strict';
const { portraitLayout } = require('../../workers/render');

describe('竖屏合成布局（v2.6.3 方案 A · v2.6.4 字幕顶锚定）', () => {
  test('默认 720×1280：16:9 条带居中 + 字幕顶边紧贴画面下方', () => {
    expect(portraitLayout()).toEqual({
      w: 720,
      h: 1280,
      sigma: 22,
      picH: 405,
      picTop: 438,
      picBottom: 843,
      gap: 26,
      marginVTop: 869,
      fontsize: 42,
    });
  });

  test('字幕顶边恒在画面底边下方一个 gap（不重叠、不远离）', () => {
    for (const h of [1080, 1280, 1920, 2560]) {
      const L = portraitLayout({ w: 720, h });
      expect(L.marginVTop - L.picBottom).toBe(L.gap);
      expect(L.marginVTop).toBeGreaterThan(L.picBottom);
    }
  });

  test('条带保持 16:9 且垂直居中（内容不裁切）', () => {
    const L = portraitLayout();
    expect(L.picH).toBe(Math.round((L.w * 9) / 16));
    expect(L.picTop).toBe(Math.round((L.h - L.picH) / 2));
  });

  test('gap 可调（0 表示字幕顶边正好贴画面底边）', () => {
    expect(portraitLayout({ gap: 0 }).marginVTop).toBe(portraitLayout().picBottom);
  });

  test('字号随画布宽等比（≈5.8%），极小尺寸有下限保护前的线性关系', () => {
    expect(portraitLayout({ w: 1080, h: 1920 }).fontsize).toBe(Math.round(1080 * 0.058));
  });

  test('极小尺寸下 sigma 有下限 8（避免模糊不可见）', () => {
    expect(portraitLayout({ w: 100, h: 200 }).sigma).toBe(8);
  });
});
