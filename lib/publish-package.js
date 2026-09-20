'use strict';
/**
 * publish-package.js —— 多平台发布包（阶段一）纯函数：平台文案推导 + 包清单 + 上传指引。
 *
 * 背景：平台已能自动产出「成片 + 发布文案 + 封面」，但发布仍是手工。阶段一只做**本地物料生成**：
 * 各平台规格的成片/封面/文案齐备，用户「选文件 → 点发布」，**不涉及任何登录态与风控**。
 *
 * 本模块零 IO、零 ffmpeg（编排见 workers/render.js 的 buildPublishPackage）：
 *   输入 = 项目 + 渲染任务 + 策展数据（tools/publish/*.json）→ 输出 = 结构数据 / 纯文本。
 *
 * 平台差异（决定物料形状）：
 *   B 站     16:9 成片直接可用；长标题（≤80 字，带集号）；长简介 + 合集归类；标签 ≤10 个。
 *   抖音/快手 9:16 竖屏（模糊背景填充切片）；短、强钩子标题 + `#话题`；一句话简介。
 */
const { safeProjectName } = require('./artifacts');

/** 平台目录与交付物（数组顺序即 README / 弹窗展示顺序）
 *  files 为函数：入参 = 成片文件名主干（v2.6.5 起为作品名，如「幻灯屋 S1E07 忘れ傘」） */
const PLATFORMS = [
  {
    key: 'bilibili',
    dir: 'B站',
    label: '哔哩哔哩',
    files: (film) => [
      { name: `${film}.mp4`, role: '视频（本项目原始画幅，直接上传）' },
      { name: '封面.png', role: '封面（16:9，B 站建议 ≥1146×717）' },
      { name: '文案.txt', role: '标题（≤80 字）/ 简介 / 标签 / 分区合集 / 置顶评论' },
    ],
  },
  {
    key: 'douyin',
    dir: '抖音',
    label: '抖音 / 快手',
    files: (film) => [
      { name: `${film}-竖屏.mp4`, role: '视频（9:16 竖屏，模糊背景填充，构图不裁切）' },
      { name: '封面-竖屏.png', role: '竖屏封面' },
      { name: '文案.txt', role: '短标题 / 话题标签 / 一句话简介' },
    ],
  },
];

const BILI_TITLE_MAX = 80; // B 站标题上限
const DY_TITLE_MAX = 30; // 抖音短标题上限（强钩子）
const DY_DESC_MAX = 80; // 抖音一句话简介上限
const DY_HASHTAG_MAX = 6; // 抖音话题标签个数上限

/** 按「字」截断（不用码元切，避免把中文/emoji 截断成乱码） */
function clampChars(s, max) {
  const t = String(s == null ? '' : s).trim();
  const arr = Array.from(t);
  return arr.length <= max ? t : arr.slice(0, Math.max(1, max - 1)).join('') + '…';
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/** 长标题 → 短视频短标题：去掉【…】前缀，遇「｜/|」取**最后一段**（本仓系列标题形如
 *  「【系列 第N话】集名｜钩子」，钩子总在末段）；无分隔符则整串即短标题 */
function deriveShortTitle(t) {
  const s = String(t || '')
    .replace(/【[^】]*】/g, '')
    .trim();
  const parts = s
    .split(/[｜|]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/** 取首句（中文句读优先；用于把长简介压缩成短视频的一句话） */
function firstSentence(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  const m = /^[^。！？!?]*[。！？!?]/.exec(s);
  return (m ? m[0] : s).trim();
}

/**
 * 各平台文案推导（策展数据优先，缺失时按项目事实降级）
 * @param {{project: object, meta?: object, job?: object|null}} o
 * @returns {{bilibili: object, douyin: object}}
 */
function buildPlatformCopy({ project = {}, meta = {}, job = null } = {}) {
  const titles = (meta.titles || []).filter(Boolean);
  const tags = (meta.tags || []).filter(Boolean);
  const q = (job && job.quality) || {};
  // 规格行只在有成片事实（镜数/时长）时输出，避免降级场景下只剩一句「中日双语字幕」
  const spec =
    q.shots != null || q.duration_s != null
      ? [q.shots != null ? `${q.shots} 镜` : '', q.duration_s != null ? fmtDuration(q.duration_s) : '', '中日双语字幕']
          .filter(Boolean)
          .join(' · ')
      : '';
  const seriesLine = meta.series
    ? `系列：${meta.series}${meta.episode ? ` · 本集 ${meta.episode}${meta.episode_title ? `《${meta.episode_title}》` : ''}` : ''}`
    : '';

  // 抖音：策展可显式覆盖短标题/一句话/话题；缺失时从长标题与标签降级推导
  const shortTitle = clampChars(
    meta.short_title || deriveShortTitle(titles[0] || project.name || '未命名'),
    DY_TITLE_MAX,
  );
  const hashtags = (Array.isArray(meta.hashtags) && meta.hashtags.length ? meta.hashtags : tags.slice(0, 5))
    .map((t) => String(t).replace(/^#/, '').trim())
    .filter(Boolean)
    .slice(0, DY_HASHTAG_MAX);
  const oneLiner = clampChars(
    meta.short_intro || firstSentence((meta.intro || [])[0] || project.idea || ''),
    DY_DESC_MAX,
  );

  return {
    bilibili: {
      title: clampChars(titles[0] || project.name || '未命名', BILI_TITLE_MAX),
      title_candidates: titles.map((t) => clampChars(t, BILI_TITLE_MAX)),
      desc: [...(meta.intro || []).filter(Boolean), spec ? `本集规格：${spec}` : '', seriesLine]
        .filter(Boolean)
        .join('\n\n'),
      tags,
      category: meta.category || '动画 → 综合动画',
      collection: meta.collection || meta.series || '',
      pinned_comment: meta.pinned_comment || '',
    },
    douyin: {
      title: shortTitle,
      desc: oneLiner,
      hashtags,
    },
  };
}

/** 平台「文案.txt」（纯文本，可直接全选复制到发布页对应输入框） */
function renderCopyText(key, copy, files = []) {
  const L = [];
  const push = (...xs) => L.push(...xs);
  if (key === 'bilibili') {
    push('=== 标题（复制到「标题」框，上限 80 字）===', copy.title, '');
    if (copy.title_candidates.length > 1) {
      push('（备选标题）', ...copy.title_candidates.slice(1).map((t, i) => `${i + 2}. ${t}`), '');
    }
    push('=== 简介（复制到「简介」框）===', copy.desc || '—', '');
    push('=== 标签（逗号分隔，最多 10 个）===', copy.tags.join(',') || '—', '');
    push('=== 分区 / 合集 ===', `分区：${copy.category}`, `合集：${copy.collection || '—'}`, '');
    if (copy.pinned_comment) push('=== 置顶评论 ===', copy.pinned_comment, '');
  } else {
    push('=== 短标题（上限 30 字，把钩子放最前）===', copy.title, '');
    push('=== 一句话简介 ===', copy.desc || '—', '');
    push(
      '=== 话题标签（发布时逐个输入 # 话题，平台会自动高亮）===',
      copy.hashtags.map((t) => '#' + t).join(' ') || '—',
      '',
    );
  }
  push('=== 上传文件 ===', ...files.map((f) => `${f.name} —— ${f.role}`));
  return L.join('\n') + '\n';
}

/**
 * 发布包 README（各平台「上传步骤 + 该传哪个文件」的清单）
 * @param {{project: object, job: object, copy: object, notes?: string[]}} o
 */
function buildPackageReadme({ project = {}, job = {}, copy = {}, notes = [] } = {}) {
  const film = safeProjectName(project, '成片'); // v2.6.5 交付物名用作品名
  const files = PLATFORMS.map(
    (p) =>
      `- \`${p.dir}/\`（${p.label}）\n` +
      p
        .files(film)
        .map((f) => `  - \`${f.name}\` —— ${f.role}`)
        .join('\n'),
  ).join('\n');
  return [
    `# 《${project.name || '未命名'}》多平台发布包（渲染 #${job.id}）`,
    '',
    '> 自动生成：策展文案来自 `tools/publish/`，事实项来自项目与渲染任务。',
    '> **不涉及任何平台登录态与风控**——把下面的文件与文案传到发布页即可。',
    '',
    '## 包内容',
    '',
    files,
    '',
    '## 上传步骤（B 站）',
    '',
    '1. 打开创作中心 → 投稿（video/upload）。',
    `2. 视频选 \`B站/${film}.mp4\`；封面选 \`B站/封面.png\`。`,
    '3. 打开 `B站/文案.txt`，把「标题」粘进标题框（≤80 字）、「简介」粘进简介框。',
    `4. 标签按 ${copy.bilibili?.tags?.length || 0} 个依次填入（最多 10 个）；分区 ${copy.bilibili?.category || '按平台默认'}。`,
    `5. 合集选「${copy.bilibili?.collection || '新建合集'}」；需要时把「置顶评论」发出去再置顶。`,
    '',
    '## 上传步骤（抖音 / 快手）',
    '',
    '1. 打开 App 或创作者中心 → 发布视频。',
    `2. 视频选 \`抖音/${film}-竖屏.mp4\`（9:16 竖屏，模糊背景填充，原构图完整）；封面选 \`抖音/封面-竖屏.png\`。`,
    '3. 打开 `抖音/文案.txt`，短标题与话题标签直接复制（话题要逐个输入 `#` 触发高亮）。',
    '4. 一句话简介可放文案末尾，或作为评论区首条。',
    '',
    '## 备注',
    '',
    ...(notes.length ? notes.map((n) => `- ${n}`) : ['- 本包由渲染归档自动生成；重渲后会整包重建，不堆积旧文件。']),
    '',
  ].join('\n');
}

module.exports = {
  PLATFORMS,
  BILI_TITLE_MAX,
  DY_TITLE_MAX,
  buildPlatformCopy,
  renderCopyText,
  buildPackageReadme,
  deriveShortTitle,
  firstSentence,
  clampChars,
  fmtDuration,
};
