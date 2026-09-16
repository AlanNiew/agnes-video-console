'use strict';
/** 多平台发布包（v2.6 阶段一）：平台文案推导 / 清单 / README 纯函数 */
const {
  PLATFORMS,
  buildPlatformCopy,
  renderCopyText,
  buildPackageReadme,
  deriveShortTitle,
  firstSentence,
  clampChars,
} = require('../../lib/publish-package');

const project = { name: '幻灯屋 S1E04 雨の音', idea: '潮见町的雨夜。' };
const meta = {
  series: '幻灯屋',
  titles: ['【幻灯屋 第4话】雨の音｜他看不见画面，只想再听一次那天的雨', '备选标题'],
  intro: ['潮见町下了一场很长的秋雨。一位拄杖的盲眼琴师站了很久。', '第二段简介。'],
  tags: ['原创动画', '动画短片', 'AI动画', '治愈', '雨', '日式动画', '幻灯屋'],
  category: '动画 → 综合动画',
  collection: '幻灯屋 第一季',
  pinned_comment: '建议戴耳机看这一集。',
};
const job = { id: 7, quality: { shots: 12, duration_s: 137.7 } };

describe('文案推导（buildPlatformCopy）', () => {
  test('B 站：长标题（≤80 字）+ 长简介含规格与系列 + 标签', () => {
    const { bilibili } = buildPlatformCopy({ project, meta, job });
    expect(bilibili.title).toContain('雨の音');
    expect(bilibili.title_candidates).toHaveLength(2);
    expect([...bilibili.title].length).toBeLessThanOrEqual(80);
    expect(bilibili.desc).toContain('本集规格：12 镜 · 2 分 18 秒 · 中日双语字幕');
    expect(bilibili.desc).toContain('系列：幻灯屋');
    expect(bilibili.tags).toHaveLength(7);
    expect(bilibili.collection).toBe('幻灯屋 第一季');
  });

  test('抖音：策展字段优先；无 short_title 时从长标题首段降级（去【】与｜后缀）', () => {
    const withCurated = buildPlatformCopy({
      project,
      meta: { ...meta, short_title: '他只想再听一次那天的雨', short_intro: '一句话。', hashtags: ['雨', '#幻灯屋'] },
      job,
    });
    expect(withCurated.douyin.title).toBe('他只想再听一次那天的雨');
    expect(withCurated.douyin.hashtags).toEqual(['雨', '幻灯屋']); // 前导 # 被剥离

    const derived = buildPlatformCopy({ project, meta, job });
    expect(derived.douyin.title).toBe('他看不见画面，只想再听一次那天的雨');
    expect(derived.douyin.hashtags).toEqual(['原创动画', '动画短片', 'AI动画', '治愈', '雨']); // tags 前 5
    expect(derived.douyin.desc).toBe('潮见町下了一场很长的秋雨。'); // 首句
  });

  test('短标题按字截断且话题数量有上限', () => {
    const t = buildPlatformCopy({
      project,
      meta: { ...meta, hashtags: ['一', '二', '三', '四', '五', '六', '七', '八'] },
      job,
    });
    expect(t.douyin.hashtags).toHaveLength(6);
    expect([...t.douyin.title].length).toBeLessThanOrEqual(30);
  });

  test('策展数据完全缺失时按项目事实降级，不抛异常', () => {
    const c = buildPlatformCopy({ project: { name: '无题' }, meta: {}, job: null });
    expect(c.bilibili.title).toBe('无题');
    expect(c.bilibili.desc).toBe(''); // 无 intro/规格/系列
    expect(c.douyin.title).toBe('无题');
    expect(c.douyin.hashtags).toEqual([]);
  });

  test('工具函数边界', () => {
    expect(clampChars('中文字符串', 3)).toBe('中文…');
    expect(clampChars('abc', 10)).toBe('abc');
    expect(deriveShortTitle('【前缀】标题A｜钩子B')).toBe('钩子B'); // 末段即钩子
    expect(deriveShortTitle('【前缀】标题A')).toBe('标题A'); // 无分隔符则整串
    expect(firstSentence('第一句。第二句。')).toBe('第一句。');
    expect(firstSentence('没有句号')).toBe('没有句号');
  });
});

describe('文案.txt / README', () => {
  test('B 站文案.txt 含标题/简介/标签/分区合集/置顶评论章节', () => {
    const copy = buildPlatformCopy({ project, meta, job });
    const txt = renderCopyText('bilibili', copy.bilibili, PLATFORMS[0].files);
    for (const k of ['标题', '简介', '标签', '分区 / 合集', '置顶评论', '上传文件']) expect(txt).toContain(k);
    expect(txt).toContain('原创动画,动画短片');
  });

  test('抖音文案.txt 含短标题/话题/上传文件，话题带 # 前缀', () => {
    const copy = buildPlatformCopy({ project, meta, job });
    const txt = renderCopyText('douyin', copy.douyin, PLATFORMS[1].files);
    for (const k of ['短标题', '话题标签', '上传文件', '成片-竖屏.mp4']) expect(txt).toContain(k);
    expect(txt).toContain('#原创动画');
  });

  test('README 含包内容、两平台上传步骤与降级备注', () => {
    const copy = buildPlatformCopy({ project, meta, job });
    const md = buildPackageReadme({ project, job, copy, notes: ['未找到封面.png'] });
    expect(md).toContain('《幻灯屋 S1E04 雨の音》多平台发布包（渲染 #7）');
    expect(md).toContain('## 上传步骤（B 站）');
    expect(md).toContain('## 上传步骤（抖音 / 快手）');
    expect(md).toContain('未找到封面.png');
    expect(md).toContain('不涉及任何平台登录态与风控');
  });
});
