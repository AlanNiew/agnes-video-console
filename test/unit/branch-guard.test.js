'use strict';
/**
 * 分支路径护栏（v2.5.5）：按分支职责校验提交路径，防"创作/平台互相污染"
 * 规则见 docs/BRANCHING.md；真实事故：E05 提交混入另一条线的 6 个 WIP 文件
 */
const { check, isCreationPath, isProcessPath } = require('../../tools/branch-guard');

describe('branch-guard（分支路径护栏）', () => {
  test('content 分支：放行创作路径，拦截平台路径', () => {
    const ok = ['docs/stories/幻灯屋-制作记录.md', 'tools/episodes/S1E05.json', 'tools/publish/S1E05.json'];
    expect(check('content/gentouya-s1', ok)).toEqual([]);
    const bad = check('content/gentouya-s1', ['workers/render.js', 'public/app.js']);
    expect(bad.map((x) => x.path)).toEqual(['workers/render.js', 'public/app.js']);
  });

  test('平台分支：放行平台路径，拦截创作路径', () => {
    expect(check('main', ['workers/submitter.js', 'docs/IMPROVEMENT_BACKLOG.md'])).toEqual([]);
    const bad = check('feature/x', ['docs/stories/a.md', 'tools/publish/S1E05.json']);
    expect(bad.map((x) => x.path)).toEqual(['docs/stories/a.md', 'tools/publish/S1E05.json']);
  });

  test('过程文件白名单：任何分支都可提交', () => {
    for (const br of ['main', 'feature/x', 'content/y']) {
      expect(check(br, ['docs/BRANCHING.md', 'tools/branch-guard.js', '.githooks/pre-commit'])).toEqual([]);
    }
  });

  test('反斜杠路径归一化；空输入不报错', () => {
    expect(check('content/y', ['docs\\stories\\a.md'])).toEqual([]);
    expect(check('content/y', ['workers\\render.js'])).toHaveLength(1);
    expect(check('main', [])).toEqual([]);
  });

  test('路径判定辅助函数', () => {
    expect(isCreationPath('docs/stories/x.md')).toBe(true);
    expect(isCreationPath('tools/episodes/S1E05.json')).toBe(true);
    expect(isCreationPath('tools/preflight.js')).toBe(false);
    expect(isProcessPath('docs/BRANCHING.md')).toBe(true);
    expect(isProcessPath('docs/CREATION_PLAYBOOK.md')).toBe(false);
  });
});
