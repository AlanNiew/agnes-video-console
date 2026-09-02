'use strict';
/**
 * ASS 字幕生成单元测试 —— buildSubtitleAss 纯函数（v1.6 字幕烧录 / v1.8.2 CJK 预换行）
 * 注意：buildSubtitleAss 未从模块导出独立函数明细，但 assTime/wrapCJK 为内部函数，
 * 这里经 buildSubtitleAss 的输出间接断言（与 e2e 的做法一致但更细）。
 */
const { buildSubtitleAss, buildSrt, escDrawtext } = require('../../render');

describe('buildSubtitleAss', () => {
  test('生成标准 ASS 头（Script Info / Style / Events）', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 2, text: '你好' }]);
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('ScriptType: v4.00+');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Style: Narr,Microsoft YaHei,42,');
    expect(ass).toContain('[Events]');
  });

  test('时间格式 H:MM:SS.cc（跨小时/进位）', () => {
    const ass = buildSubtitleAss([
      { start: 0, end: 1, text: 'a' },
      { start: 3661.5, end: 3662.5, text: 'b' }, // 1:01:01.50
    ]);
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,0:00:01\.00,/);
    expect(ass).toMatch(/Dialogue: 0,1:01:01\.50,1:01:02\.50,/);
  });

  test('过滤无效行：end ≤ start、空文本', () => {
    const ass = buildSubtitleAss([
      { start: 2, end: 4, text: '有效行' },
      { start: 4, end: 4, text: '零时长' },
      { start: 5, end: 6, text: '' },
      null,
    ]);
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]).toContain('有效行');
  });

  test('每行带 150ms 淡入淡出标签', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 1, text: 'x' }]);
    expect(ass).toContain('{\\fad(150,150)}');
  });

  test('长中文按字数预换行（\\N），行首不出现标点', () => {
    // fontsize=42、playResX=1280 → maxChars = floor(1160/42)-1 = 26
    const long = '一二三四五六七八九十'.repeat(6) + '，。'; // 62 字含尾随标点
    const ass = buildSubtitleAss([{ start: 0, end: 2, text: long }]);
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
    const text = dialogue.slice(dialogue.indexOf(',,') + 2); // 跳过元数据段拿正文（含 fad 标签）
    const body = text.replace(/^\{\\fad\(150,150\)\}/, '');
    const lines = body.split('\\N');
    expect(lines.length).toBeGreaterThan(1); // 确实发生了换行
    const NO_LEAD = '。，、；：？！）」』】》·—…';
    for (const line of lines) {
      expect(NO_LEAD.includes(line[0])).toBe(false); // 行首标点已回收
    }
  });

  test('短文本不换行，花括号字符被剥离（ASS 特殊字符防注入）', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 1, text: '正常字幕' }]);
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
    expect(dialogue).toContain('正常字幕');
    expect(dialogue).not.toContain('\\N');

    const evil = buildSubtitleAss([{ start: 0, end: 1, text: '{\\pos(1,1)}注入' }]);
    const d2 = evil.split('\n').find((l) => l.startsWith('Dialogue:'));
    // assEscape 剥离花括号字符：\pos 无 {} 包裹即不构成 override block，无害化
    // （Dialogue 自带的 {\fad(150,150)} 是模板合法标签，不受影响）
    expect(d2).not.toContain('{\\pos');
    expect(d2).toContain('注入');
  });

  test('自定义 fontsize / playResX 生效于 Style 与换行宽度', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 1, text: 'x' }], {
      fontsize: 56,
      playResX: 720,
      playResY: 1280,
      marginV: 80,
    });
    expect(ass).toContain('Style: Narr,Microsoft YaHei,56,');
    expect(ass).toContain('PlayResX: 720');
    expect(ass).toContain('PlayResY: 1280');
    expect(ass).toContain(',80,1'); // MarginV
  });

  test('v2.0 字幕样式预设：yellow-box 金字底框（BorderStyle=3 + 金色）', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 1, text: 'x' }], { style: 'yellow-box' });
    expect(ass).toContain('&H005CD7FF'); // 金色主色
    expect(ass).toMatch(/,3,1\.2,0,/); // BorderStyle=3, Outline=1.2, Shadow=0
  });

  test('v2.0 字幕样式预设：bottom-bar（BorderStyle=3 + 纯白主色）', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 1, text: 'x' }], { style: 'bottom-bar' });
    expect(ass).toContain('&H00FFFFFF');
    expect(ass).toMatch(/,3,1\.6,0,/);
  });

  test('v2.0 字幕位置：center → Alignment=5（屏幕居中）', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 1, text: 'x' }], { position: 'center' });
    // Style 行尾段：Alignment 在 Shadow 之后，2=底部居中（默认）5=屏幕居中
    expect(ass).toMatch(/,1,2\.2,1\.2,5,60,60,/);
  });

  test('v2.0 非法样式/位置兜底默认（white-outline + bottom）', () => {
    const ass = buildSubtitleAss([{ start: 0, end: 1, text: 'x' }], {
      style: 'evil-injected',
      position: 'diag',
    });
    expect(ass).toContain('&H00DCECF2'); // 默认白字
    expect(ass).toMatch(/,1,2\.2,1\.2,2,60,60,/); // 默认 BorderStyle=1 + Alignment=2
  });
});

describe('escDrawtext（drawtext 滤镜文本转义，v1.9.2）', () => {
  test("转义集完整：\\ % ' :（按此顺序，先 \\ 防二阶转义）", () => {
    expect(escDrawtext('a\\b')).toBe('a\\\\b');
    expect(escDrawtext('100%')).toBe('100\\%');
    expect(escDrawtext("it's")).toBe("it\\'s");
    expect(escDrawtext('a:b')).toBe('a\\:b');
  });

  test('% 转义阻断 ffmpeg 表达式求值（expansion=normal 的 %{expr} 注入）', () => {
    expect(escDrawtext('%{n/frame_rate}')).toBe('\\%{n/frame_rate}');
    // 注意表达式内的 : 同样会被 : 转义规则覆盖（双保险）
    expect(escDrawtext('评分 %{eif:2*3} 分')).toBe('评分 \\%{eif\\:2*3} 分');
  });

  test('普通中文/英文原样通过', () => {
    expect(escDrawtext('黄昏麦田少年')).toBe('黄昏麦田少年');
    expect(escDrawtext('')).toBe('');
    expect(escDrawtext(null)).toBe('');
    expect(escDrawtext(undefined)).toBe('');
  });

  test('组合逃逸尝试全部被中和', () => {
    // 尝试用 % 和 ' 组合闭合引号并求值表达式 → 两处均被转义
    const evil = "'%{pts}";
    expect(escDrawtext(evil)).toBe("\\'\\%{pts}");
  });
});

describe('buildSrt（v2.2 作品归档 SRT 导出）', () => {
  test('标准 SRT 结构：序号 + HH:MM:SS,mmm 时间轴 + 文本 + 空行分隔', () => {
    const srt = buildSrt([{ start: 1.5, end: 3.25, text: '末班车开走了' }]);
    expect(srt).toBe('1\n00:00:01,500 --> 00:00:03,250\n末班车开走了\n');
  });

  test('跨小时/毫秒进位格式正确', () => {
    const srt = buildSrt([{ start: 3661.005, end: 3662.999, text: 'x' }]);
    expect(srt).toContain('01:01:01,005 --> 01:01:02,999');
  });

  test('过滤无效行（end≤start / 空文本 / null），多行文本压成单行', () => {
    const srt = buildSrt([
      { start: 0, end: 1, text: '第一句' },
      { start: 2, end: 2, text: '零时长' },
      { start: 3, end: 4, text: '' },
      null,
      { start: 5, end: 6, text: '多行\n台词' },
    ]);
    expect(srt).toContain('第一句');
    expect(srt).toContain('多行 台词');
    expect(srt).not.toContain('零时长');
    expect((srt.match(/^\d+$/gm) || []).length).toBe(2); // 只有序号 1、2
  });

  test('空输入返回空串', () => {
    expect(buildSrt([])).toBe('');
    expect(buildSrt(null)).toBe('');
  });
});
