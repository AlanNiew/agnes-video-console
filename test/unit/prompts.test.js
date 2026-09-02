'use strict';
/**
 * prompts 单元测试 —— LLM 输出容错解析与分镜规范化
 */

const {
  parseLLMJson,
  normalizeStoryboardShots,
  clampNarration,
  SCRIPT_SYSTEM_PROMPT,
  STORYBOARD_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
} = require('../../services/prompts');

describe('parseLLMJson', () => {
  test('直接 JSON 解析', () => {
    expect(parseLLMJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('剥掉 ```json 围栏', () => {
    expect(parseLLMJson('```json\n{"a":1,"b":[1,2]}\n```')).toEqual({ a: 1, b: [1, 2] });
    expect(parseLLMJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('从前后噪声文字中提取首个平衡对象', () => {
    expect(parseLLMJson('好的，以下是结果：{"script":"梗概","n":3} 希望有帮助')).toEqual({ script: '梗概', n: 3 });
  });

  test('嵌套对象正确提取', () => {
    const out = parseLLMJson('prefix {"outer":{"inner":true},"arr":[{}]} suffix');
    expect(out).toEqual({ outer: { inner: true }, arr: [{}] });
  });

  test('坏输入返回 null（不抛异常）', () => {
    expect(parseLLMJson(null)).toBeNull();
    expect(parseLLMJson('')).toBeNull();
    expect(parseLLMJson('完全不是 JSON')).toBeNull();
    expect(parseLLMJson('{"unclosed": ')).toBeNull();
    expect(parseLLMJson('prefix {"a":bad} suffix')).toBeNull();
  });

  test('只有围栏开头没有对象时返回 null', () => {
    expect(parseLLMJson('```json\n没有对象\n```')).toBeNull();
  });
});

describe('normalizeStoryboardShots', () => {
  test('基本规范化：重编 seq、补齐字段', () => {
    const out = normalizeStoryboardShots([
      { seq: 5, title: '  开场·麦田全景  ', video_prompt: '大全景…', narration: ' 旁白一 ', seconds: '6' },
      { video_prompt: '第二镜提示词' },
    ]);
    expect(out).toEqual([
      { seq: 1, title: '开场·麦田全景', video_prompt: '大全景…', narration: '旁白一', seconds: '6', mode: 'reference' },
      { seq: 2, title: null, video_prompt: '第二镜提示词', narration: null, seconds: '5', mode: 'reference' },
    ]);
  });

  test('空提示词镜头被丢弃且 seq 连续', () => {
    const out = normalizeStoryboardShots([{ video_prompt: '' }, { video_prompt: '   ' }, { video_prompt: '有效镜头' }]);
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(1);
  });

  test('seconds 非法回退 fallback；fallback 非法回退 5', () => {
    const out = normalizeStoryboardShots([{ video_prompt: 'x', seconds: '99' }], '8');
    expect(out[0].seconds).toBe('8');
    const out2 = normalizeStoryboardShots([{ video_prompt: 'x', seconds: '99' }], 'not-ok');
    expect(out2[0].seconds).toBe('5');
  });

  test('超上限截断到 MAX_SHOTS=20，空输入返回空数组', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ video_prompt: `镜头${i}` }));
    expect(normalizeStoryboardShots(many)).toHaveLength(20);
    expect(normalizeStoryboardShots(null)).toEqual([]);
    expect(normalizeStoryboardShots([])).toEqual([]);
  });

  test('title 截断到 100 字、video_prompt 截断到 8000 字', () => {
    const out = normalizeStoryboardShots([{ title: '长'.repeat(150), video_prompt: 'p'.repeat(9000) }]);
    expect(out[0].title).toHaveLength(100);
    expect(out[0].video_prompt).toHaveLength(8000);
  });

  test('v2.0.3 旁白按镜头秒数限长：5 秒镜 ≤ 20 字（含标点），超长在句读处截断', () => {
    // 5s 镜 38 字旁白（旧 bug 真实样本形态）→ 截到 ≤21 字且以句读收尾
    const long = '末班地铁开走后，只剩老周一人在车厢里慢慢拖着地。四十年了，他习惯了这种安静。';
    const out = normalizeStoryboardShots([{ video_prompt: 'x', narration: long, seconds: '5' }]);
    const n = out[0].narration;
    expect(n.length).toBeLessThanOrEqual(21);
    expect(/[。！？，；]$/.test(n)).toBe(true);
    // 长镜不受 5 秒上限影响（10s ≤ 40 字）
    const mid = '他数着自己的脚步，像数着一整个夏天的黄昏。';
    expect(normalizeStoryboardShots([{ video_prompt: 'x', narration: mid, seconds: '10' }])[0].narration).toBe(mid);
  });
});

describe('clampNarration（v2.0.3 旁白限长纯函数）', () => {
  test('未超上限原样返回（含 null/空归一化为 null）', () => {
    expect(clampNarration('短旁白。', 5)).toBe('短旁白。');
    expect(clampNarration(null, 5)).toBeNull();
    expect(clampNarration('', 5)).toBeNull();
  });

  test('上限 = 秒数 × 4（5s→20、12s→48）；无句读时硬截断', () => {
    expect(clampNarration('一'.repeat(19), 5)).toHaveLength(19);
    expect(clampNarration('一'.repeat(25), 5)).toHaveLength(20); // 无句读 → 硬截 20
    expect(clampNarration('一'.repeat(50), 12)).toHaveLength(48);
  });

  test('超长优先在句读处截断，且保留至少 8 字', () => {
    const r = clampNarration('前八个字没有句读然后出现逗号，后面是很长很长很长很长很长的尾巴内容超过上限。', 5);
    expect(r.length).toBeLessThanOrEqual(21);
    expect(r).toContain('，');
    // 句读过早（截后不足 8 字）→ 舍弃句读硬截断
    const early = clampNarration('两字，后面全是没有任何标点的超长内容超出五秒上限很多很多', 5);
    expect(early.length).toBeLessThanOrEqual(21);
  });

  test('seconds 非法按 5 秒兜底', () => {
    expect(clampNarration('一'.repeat(25), 'abc')).toHaveLength(20);
  });
});

describe('prompt 模板完整性（防误删/篡改）', () => {
  test('文案模板含四字段契约与一致性要求', () => {
    for (const key of ['script', 'video_prompt', 'character_desc', 'scene_desc']) {
      expect(SCRIPT_SYSTEM_PROMPT).toContain(`"${key}"`);
    }
    expect(SCRIPT_SYSTEM_PROMPT).toContain('只输出一个 JSON 对象');
  });

  test('分镜模板含 shots 契约与秒数约束', () => {
    expect(STORYBOARD_SYSTEM_PROMPT).toContain('"shots"');
    expect(STORYBOARD_SYSTEM_PROMPT).toContain('narration');
    expect(STORYBOARD_SYSTEM_PROMPT).toContain('"4"~"12"');
    // v2.0.3：旁白字数与镜头秒数挂钩（配音约 5 字/秒，超长会被截断）
    expect(STORYBOARD_SYSTEM_PROMPT).toContain('seconds × 4');
  });

  test('审查模板含旁白时长维度（v2.0.3）', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain('seconds × 4');
  });
});
