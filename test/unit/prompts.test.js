'use strict';
/**
 * prompts 单元测试 —— LLM 输出容错解析与分镜规范化
 */

const {
  parseLLMJson,
  normalizeStoryboardShots,
  SCRIPT_SYSTEM_PROMPT,
  STORYBOARD_SYSTEM_PROMPT,
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
  });
});
