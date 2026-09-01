'use strict';
/**
 * constants.js —— 模型清单 / 参数白名单 / 输入上限 / TTS 预设（v1.9.1 拆分自 server.js）
 * 单一事实来源：前端下拉与提示文案全部经 GET /api/meta 由此渲染。
 * 注意：此文件必须保持零依赖，可被任何模块安全 require。
 */

/** 视频生成模型（按家族分发参数体系） */
const MODELS = {
  'agnes-video-2.5-flash': {
    family: 'v25',
    sizes: ['720P'],
    free: true,
    short: 'Flash',
    hint: '限时免费 · 仅 720P · reference 最多 5 张图片 · 不支持视频参考',
    label: 'Agnes Video 2.5 Flash（最新 · 免费）',
    rate_limit: '1 次创建/分钟（免费档限流，提交已由服务端队列自动节流）',
  },
  'agnes-video-2.5': {
    family: 'v25',
    sizes: ['720P', '960P', '2K'],
    free: false,
    short: '2.5',
    hint: '付费 · 720P/960P/2K · 支持视频参考',
    label: 'Agnes Video 2.5（付费）',
    rate_limit: '以账户配额为准',
  },
  'agnes-video-v2.0': {
    family: 'v2',
    sizes: [],
    free: true,
    short: 'V2.0（旧）',
    deprecated: true,
    hint: '旧模型 · 已从界面下架（后端兼容保留）',
    label: 'Agnes Video V2.0（旧模型 · 下架）',
    rate_limit: null,
  },
};

/* 2.5 家族 / V2.0 家族模式 */
const MODES = ['text', 'keyframe', 'reference'];
const V2_MODES = ['text', 'image', 'keyframes'];

/* 画幅 / 时长 / 项目状态 / 文案类别 */
const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const SECONDS_OK = Array.from({ length: 9 }, (_, i) => String(i + 4)); // '4'..'12'
const PROJECT_STATUSES = ['draft', 'copy_done', 'character_done', 'video_submitted'];
const SCRIPT_KINDS = ['script', 'video_prompt', 'character_desc', 'scene_desc'];

/* 分镜 */
const SHOT_COUNTS = ['auto', '3', '5', '8']; // 分镜生成可选镜头数
const SHOT_MODES = ['reference', 'text']; // 镜头模式（keyframe 为 M2+ 预留）
const MAX_SHOTS = 20; // 每项目镜头数上限

/* 流水线模型（最新免费三件套，M1 固定值） */
const LLM_MODEL = 'agnes-2.5-flash'; // 文本：提示词优化/文案
const IMAGE_MODEL = 'agnes-image-2.1-flash'; // 图片：角色/场景
const IMAGE_SIZES = ['1K', '2K', '3K', '4K'];
const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/* 输入上限 */
const MAX_TEXT_LEN = 8000; // 提示词/创意/文案等长文本上限
const MAX_MESSAGES = 20; // /api/llm/chat 消息条数上限
const MAX_INPUT_IMAGES = 5; // 图片生成输入图上限

/* TTS（Fish Audio） */
// 常用音色快捷清单（缺省 default = 平台默认音色；其余为 Fish 音色库公开模型 id，供前端下拉）
// 支持自定义音色：从 Fish 平台挑选音色后，将 {id, title, desc} 加入此处即可在前端选用
const TTS_VOICES = [
  { id: 'default', title: '平台默认音色', desc: '不指定音色，用 Fish 平台默认声线（免费档推荐）' },
  {
    id: '6fc59d2b56cf402eb572934114c8d8aa',
    title: '仿真人·故事男声',
    desc: '成熟男声、情绪平稳，适合故事旁白（小满同款）',
  },
  { id: '59cb5986671546eaa6ca8ae6f29f6d22', title: '央视配音·男声', desc: '专业中年男声、权威清晰，适合纪录片式旁白' },
  { id: '918a8277663d476b95e2c4867da0f6a6', title: '沉稳男声·广播', desc: '有分量感的中低音，适合人生感悟类口播' },
  { id: 'bc9e47fd83a04010ad6617ed54b92ee3', title: '活力男声·解说', desc: '快节奏、有说服力，适合干货口播' },
  {
    id: '7f92f8afb8ec43bf81429cc1c9199cb1',
    title: 'AD学姐·御姐女声',
    desc: '年轻御姐感、舒缓深沉，适合文艺旁白与情感叙事（用户自选）',
  },
];
const TTS_MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'];
const TTS_MAX_TEXT = 8000;

/* v1.9 声音广场：浏览社区音色的排序方式 */
const MARKET_SORTS = ['trending', 'task_count', 'created_at', 'title'];

module.exports = {
  MODELS,
  MODES,
  V2_MODES,
  ASPECT_RATIOS,
  SECONDS_OK,
  PROJECT_STATUSES,
  SCRIPT_KINDS,
  SHOT_COUNTS,
  SHOT_MODES,
  MAX_SHOTS,
  LLM_MODEL,
  IMAGE_MODEL,
  IMAGE_SIZES,
  IMAGE_RATIOS,
  MAX_TEXT_LEN,
  MAX_MESSAGES,
  MAX_INPUT_IMAGES,
  TTS_VOICES,
  TTS_MODELS,
  TTS_MAX_TEXT,
  MARKET_SORTS,
};
