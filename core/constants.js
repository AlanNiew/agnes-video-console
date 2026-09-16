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
    short: 'V2.0',
    // deprecated 仅表示「不在主界面可选」（前端下拉/默认模型据此过滤）——官方并未下架本模型，
    // 仍在售且当前免费；API 兼容层保留，可经 /api/tasks 直接提交使用（文生/图生/keyframes）。
    deprecated: true,
    hint: '官方在售免费档 · 界面默认不展示（主推 2.5 Flash 能力更全）；API 仍可经 /api/tasks 直接调用',
    label: 'Agnes Video V2.0（官方在售 · 兼容保留）',
    rate_limit: null,
  },
};

/**
 * 即梦（官方 dreamina CLI）视频模型 —— 与 Agnes 的 MODELS **分离维护**：
 * 故意不进 /api/meta 的模型清单，故前端下拉/默认模型不受影响；
 * 仅可经 /api/tasks 直接指定 model 调用（provider 由 providerOf 推导）。
 * 参数矩阵取自 `dreamina text2video -h`（CLI v1.4.18 实测）；CLI 侧对取值做严格校验，
 * 不支持或旧版取值会被拒绝而非静默调整，故此处白名单需与 CLI 保持同步。
 */
const DREAMINA_VIDEO_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'];
const DREAMINA_RESOLUTIONS = ['480p', '720p', '1080p', '4k']; // 全局并集；各模型实际支持见 resolutions
const DREAMINA_MODELS = {
  'seedance2.0fast': {
    provider: 'dreamina',
    model_version: 'seedance2.0fast',
    subcommand: 'text2video',
    resolutions: ['720p'],
    minDuration: 4,
    maxDuration: 15,
    ratios: DREAMINA_VIDEO_RATIOS,
    vipOnly: false,
    label: 'Seedance 2.0 Fast（即梦 · 720p · 4-15s）',
  },
  'seedance2.0': {
    provider: 'dreamina',
    model_version: 'seedance2.0',
    subcommand: 'text2video',
    resolutions: ['720p'],
    minDuration: 4,
    maxDuration: 15,
    ratios: DREAMINA_VIDEO_RATIOS,
    vipOnly: false,
    label: 'Seedance 2.0（即梦 · 720p · 4-15s）',
  },
  'seedance2.0mini': {
    provider: 'dreamina',
    model_version: 'seedance2.0mini',
    subcommand: 'text2video',
    resolutions: ['720p'],
    minDuration: 4,
    maxDuration: 15,
    ratios: DREAMINA_VIDEO_RATIOS,
    vipOnly: false,
    label: 'Seedance 2.0 Mini（即梦 · 720p · 4-15s）',
  },
  'seedance2.0_vip': {
    provider: 'dreamina',
    model_version: 'seedance2.0_vip',
    subcommand: 'text2video',
    resolutions: ['720p', '1080p', '4k'],
    minDuration: 4,
    maxDuration: 15,
    ratios: DREAMINA_VIDEO_RATIOS,
    vipOnly: true,
    label: 'Seedance 2.0 VIP（即梦 · 720p/1080p/4k · 4-15s）',
  },
  'seedance2.0fast_vip': {
    provider: 'dreamina',
    model_version: 'seedance2.0fast_vip',
    subcommand: 'text2video',
    resolutions: ['720p'],
    minDuration: 4,
    maxDuration: 15,
    ratios: DREAMINA_VIDEO_RATIOS,
    vipOnly: true,
    label: 'Seedance 2.0 Fast VIP（即梦 · 720p · 4-15s）',
  },
  'seedance2.5': {
    provider: 'dreamina',
    model_version: 'seedance2.5',
    subcommand: 'text2video',
    resolutions: ['480p', '720p', '1080p'],
    minDuration: 4,
    maxDuration: 30,
    ratios: DREAMINA_VIDEO_RATIOS,
    vipOnly: true,
    label: 'Seedance 2.5（即梦 · 480p/720p/1080p · 4-30s · 需高级会员）',
  },
};

/**
 * 即梦图片模型（text2image）—— 与即梦视频同属 dreamina provider，但参数体系不同
 * （resolution_type / generate_num，且为异步任务）。参数矩阵取自 `dreamina text2image -h`（v1.4.18 实测）。
 * 按积分成本梯度提供三档，贯彻「Agnes 免费打主力、即梦只砸关键处」的均衡策略：
 * 角色图 / 封面这类「量少但决定成败」的资产生成走这里，分镜视频仍以免费 Agnes 为主。
 */
const DREAMINA_IMAGE_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
const DREAMINA_IMAGE_MODELS = {
  'jimeng-image-3.1': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '3.1',
    resolutions: ['1k', '2k'],
    label: '即梦图片 3.1（1k/2k · 最省积分）',
  },
  'jimeng-image-5.0': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '5.0',
    resolutions: ['2k', '4k'],
    label: '即梦图片 5.0（2k/4k · 性价比主力）',
  },
  'jimeng-image-5.0pro': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '5.0Pro',
    resolutions: ['1.5k', '2k', '4k'],
    label: '即梦图片 5.0 Pro（1.5k/2k/4k · 最强）',
  },
};

/**
 * 即梦积分单价表（成本护栏的数据基础）。
 *
 * source 语义：
 *   'measured'  —— 实测标定，可信
 *   'estimated' —— 推断值，UI 必须提示「实际以扣费为准」
 *
 * 计费模式差异（实测确认）：
 *   视频按**秒**计费；图片按**次**计费 —— 一次请求返回 4 张候选，故图片成本与 count 无关。
 *
 * 已知实测：图片 3.1/1k = 1 积分；视频 720p = 5 积分/秒（5s 共 25 积分）。
 * 其余为推断，待用最低规格各跑一次后升级为 measured（见 docs/DREAMINA_CLI_PLAN.md 4.1）。
 */
const DREAMINA_CREDIT_COST = {
  video: {
    '480p': { perSecond: 3, source: 'estimated' },
    '720p': { perSecond: 5, source: 'measured' },
    '1080p': { perSecond: 15, source: 'estimated' },
    '4k': { perSecond: 40, source: 'estimated' },
  },
  image: {
    'jimeng-image-3.1': { perRequest: { '1k': 1, '2k': 2 }, source: 'measured' },
    'jimeng-image-5.0': { perRequest: { '2k': 3, '4k': 6 }, source: 'estimated' },
    'jimeng-image-5.0pro': { perRequest: { '1.5k': 4, '2k': 6, '4k': 10 }, source: 'estimated' },
  },
};

/** 成本确认阈值默认值（积分）：预估 ≤ 阈值静默提交，> 阈值需前端弹窗确认 */
const DREAMINA_DEFAULT_THRESHOLD = 10;

/**
 * 由模型名推导上游 provider。
 * 未知模型一律按 'agnes' 处理，保证历史数据与既有调用向后兼容。
 * @param {string} model
 * @returns {'agnes'|'dreamina'}
 */
function providerOf(model) {
  const isDreamina =
    Object.prototype.hasOwnProperty.call(DREAMINA_MODELS, model) ||
    Object.prototype.hasOwnProperty.call(DREAMINA_IMAGE_MODELS, model);
  return isDreamina ? 'dreamina' : 'agnes';
}

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
// 图片：角色/场景（v2.2.3 由 agnes-image-2.1-flash 升到最新一代 2.5-flash——请求/响应参数、
// size 档位、ratio 白名单、图生图 extra_body.image 与 extra_body.response_format 均与 2.1 一致）
const IMAGE_MODEL = 'agnes-image-2.5-flash';
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

/* v2.5 角色库（跨项目复用的角色资产）与分镜批量导入 */
const MAX_CHARACTERS = 50; // 角色库条目上限
const MAX_BULK_SHOTS = 20; // 单次批量导入镜头数上限（与 MAX_SHOTS 一致）

/* v2.0 一键成片高级配置：转场类型（xfade 白名单）/ 字幕样式 / 字幕位置 */
const RENDER_TRANSITIONS = ['fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'slidedown', 'circleopen'];
const SUBTITLE_STYLES = ['white-outline', 'yellow-box', 'bottom-bar'];
const SUBTITLE_POSITIONS = ['bottom', 'center'];

/* v2.1 全自动成片 BGM 阶段：项目风格 → 搜索词映射（顺序敏感：先匹配先赢）。
 * 兜底为「轻音乐」——内容创作类视频纯轻音乐最稳：不抢观众注意力、衬托旁白、普适性强。 */
const STYLE_BGM_KEYWORDS = [
  [/治愈|温暖|治疗|治愈系/, '钢琴'],
  [/热血|燃向|动漫|少年感/, '摇滚'],
  [/悬疑|恐怖|惊悚|紧张/, '氛围弦乐'],
  [/国风|水墨|古风|汉服/, '古筝'],
  [/童话|绘本|儿童|亲子/, '八音盒'],
  [/赛博|科幻|未来/, '电子'],
  [/纪录|写实|人文/, '轻音乐'],
];
const STYLE_BGM_DEFAULT_KEYWORD = '轻音乐';

module.exports = {
  MODELS,
  DREAMINA_MODELS,
  DREAMINA_IMAGE_MODELS,
  DREAMINA_RESOLUTIONS,
  DREAMINA_VIDEO_RATIOS,
  DREAMINA_IMAGE_RATIOS,
  DREAMINA_CREDIT_COST,
  DREAMINA_DEFAULT_THRESHOLD,
  providerOf,
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
  MAX_CHARACTERS,
  MAX_BULK_SHOTS,
  RENDER_TRANSITIONS,
  SUBTITLE_STYLES,
  SUBTITLE_POSITIONS,
  STYLE_BGM_KEYWORDS,
  STYLE_BGM_DEFAULT_KEYWORD,
};
