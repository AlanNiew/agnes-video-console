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
};

/**
 * 已下线模型（官方公告：Agnes Video v2.0 于 2026-09-25 23:59:59 UTC+8 正式下线）。
 * 保留这张表只为**给旧任务一个清晰的报错**，而不是让它静默回退到默认模型、
 * 或在界面上继续可选。历史任务记录里的 model 字段保持原样（仅用于展示）。
 */
const RETIRED_MODELS = {
  'agnes-video-v2.0': '2026-09-25',
};

/**
 * 即梦（官方 dreamina CLI）视频模型 —— 与 Agnes 的 MODELS **分离维护**：
 * 故意不进 /api/meta 的 models 清单，故前端下拉/默认模型不受影响。
 * 参数矩阵取自 `dreamina <子命令> -h`（CLI v1.4.18 实测）；CLI 侧对取值做严格校验，
 * 不支持或旧版取值会被拒绝而非静默调整，故此处白名单需与 CLI 保持同步。
 *
 * ⚠️ **不同子命令的支持集与规格各不相同**，故用 `specs` 按子命令声明：
 *   text2video  : 2.0 / 2.0fast / 2.0mini / 2.0_vip / 2.0fast_vip / 2.5
 *   image2video : 上述全部 + **seedance1.0fast / 1.5pro**（老代际仅支持图生视频）
 * 未列出的子命令 = 该模型不支持（服务端据此拒绝，不静默降级）。
 *
 * 主力/备用：整体主链路是 Agnes 免费档；即梦视频的**默认主力为 `seedance2.0mini`**
 * （置于列表首位：官方定位极致性价比 + 相近体验 + 比 Fast 快 2 倍，且单模型覆盖多种模式），
 * 其余按能力/成本递增作为备用。
 */
const DREAMINA_VIDEO_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'];
const DREAMINA_RESOLUTIONS = ['480p', '720p', '1080p', '4k']; // 全局并集；各模型/子命令实际支持见 specs
const DREAMINA_MODELS = {
  // —— 主力档（列表首位 = 前端默认选中） ——
  // Seedance 2.0 Mini：官方定位「极致性价比 · 相近体验 · 比 Fast 快 2 倍」，
  // 且单模型覆盖多种模式（文生 / 首尾帧 / 智能多帧 / 全能参考），故设为默认主力。
  // ⚠️ 其**积分**单价尚未单独实测（官方公开的是火山方舟 API 的现金价），
  // 当前按 Fast 同档（720p = 5 积分/秒）保守估计——官方称 Mini 更便宜，故属高估，
  // 护栏只会更早提示，偏安全。实测后可在 DREAMINA_CREDIT_COST.videoByModel 中覆盖。
  'seedance2.0mini': {
    provider: 'dreamina',
    modelVersion: 'seedance2.0mini',
    vipOnly: false,
    specs: {
      text2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
      image2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
    },
    label: 'Seedance 2.0 Mini（720p · 4-15s · 主力 · 极致性价比）',
  },
  // —— 备选同档（与 Mini 规格相同；若实测 Mini 反而更贵，可切回此项） ——
  'seedance2.0fast': {
    provider: 'dreamina',
    modelVersion: 'seedance2.0fast',
    vipOnly: false,
    specs: {
      text2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
      image2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
    },
    label: 'Seedance 2.0 Fast（720p · 4-15s · 备选）',
  },
  'seedance2.0': {
    provider: 'dreamina',
    modelVersion: 'seedance2.0',
    vipOnly: false,
    specs: {
      text2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
      image2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
    },
    label: 'Seedance 2.0（720p · 4-15s）',
  },
  // —— 旗舰档（VIP） ——
  'seedance2.5': {
    provider: 'dreamina',
    modelVersion: 'seedance2.5',
    vipOnly: true,
    specs: {
      text2video: { resolutions: ['480p', '720p', '1080p'], minDuration: 4, maxDuration: 30 },
      // 2.5 的图生视频跟随首帧输出，CLI 明确**拒绝 --ratio**
      image2video: {
        resolutions: ['480p', '720p', '1080p'],
        minDuration: 4,
        maxDuration: 30,
        omitRatio: true,
      },
    },
    label: 'Seedance 2.5（480p=样片模式 / 720p / 1080p · 4-30s · VIP）',
  },
  'seedance2.0_vip': {
    provider: 'dreamina',
    modelVersion: 'seedance2.0_vip',
    vipOnly: true,
    specs: {
      text2video: { resolutions: ['720p', '1080p', '4k'], minDuration: 4, maxDuration: 15 },
      image2video: { resolutions: ['720p', '1080p', '4k'], minDuration: 4, maxDuration: 15 },
    },
    label: 'Seedance 2.0 VIP（720p/1080p/4k · 4-15s）',
  },
  'seedance2.0fast_vip': {
    provider: 'dreamina',
    modelVersion: 'seedance2.0fast_vip',
    vipOnly: true,
    specs: {
      text2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
      image2video: { resolutions: ['720p'], minDuration: 4, maxDuration: 15 },
    },
    label: 'Seedance 2.0 Fast VIP（720p · 4-15s）',
  },
  // —— 老代际：**仅支持图生视频**（官方 image2video 支持集内含之，text2video 不含） ——
  'seedance1.5pro': {
    provider: 'dreamina',
    modelVersion: 'seedance1.5pro',
    vipOnly: false,
    specs: {
      image2video: { resolutions: ['720p'], minDuration: 5, maxDuration: 12 },
    },
    label: 'Seedance 1.5 Pro（720p · 5-12s · 仅图生视频）',
  },
  'seedance1.0fast': {
    provider: 'dreamina',
    modelVersion: 'seedance1.0fast',
    vipOnly: false,
    specs: {
      image2video: { resolutions: ['720p'], minDuration: 5, maxDuration: 10 },
    },
    label: 'Seedance 1.0 Fast（720p · 5-10s · 仅图生视频）',
  },
};

/** 即梦视频已接入的子命令（其余官方支持但本系统暂未开放，见 docs/DREAMINA_CLI_PLAN.md） */
const DREAMINA_VIDEO_COMMANDS = ['text2video', 'image2video'];

/**
 * 即梦图片**主力档**（高性价比：实测 1 积分/次、一次约 4 张候选）。
 * 前端图片下拉默认选中它，全自动成片的角色图阶段也用它——两处一致，避免策略漂移。
 */
const DREAMINA_IMAGE_DEFAULT_MODEL = 'jimeng-image-3.1';

/**
 * 即梦图片模型（text2image）—— 与即梦视频同属 dreamina provider，但参数体系不同
 * （resolution_type / generate_num，且为异步任务）。
 * 参数矩阵取自 `dreamina text2image -h`（v1.4.18 实测），**清单与官方支持集完全对齐**：
 *   3.0/3.1 -> 1k/2k；4.0/4.1/4.5/4.6/4.7/5.0 -> 2k/4k；5.0Pro -> 1.5k/2k/4k
 *
 * 主力 / 备用策略（成本均衡）：
 *   主力 = `jimeng-image-3.1`（实测 1 积分/次，一次约 4 张候选），默认选中；
 *   其余为备用档位，按需手动切换（代际越高画质越好、积分越贵）。
 */
const DREAMINA_IMAGE_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
const DREAMINA_IMAGE_MODELS = {
  // —— 主力：实测 1 积分/次，性价比最高，默认选中 ——
  'jimeng-image-3.1': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '3.1',
    resolutions: ['1k', '2k'],
    label: '即梦图片 3.1（1k/2k · 主力 · 最省积分）',
  },
  // —— 备用档位（与官方 CLI 支持集对齐） ——
  'jimeng-image-3.0': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '3.0',
    resolutions: ['1k', '2k'],
    label: '即梦图片 3.0（1k/2k · 备用）',
  },
  'jimeng-image-4.0': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '4.0',
    resolutions: ['2k', '4k'],
    label: '即梦图片 4.0（2k/4k · 备用）',
  },
  'jimeng-image-4.1': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '4.1',
    resolutions: ['2k', '4k'],
    label: '即梦图片 4.1（2k/4k · 备用）',
  },
  'jimeng-image-4.5': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '4.5',
    resolutions: ['2k', '4k'],
    label: '即梦图片 4.5（2k/4k · 备用）',
  },
  'jimeng-image-4.6': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '4.6',
    resolutions: ['2k', '4k'],
    label: '即梦图片 4.6（2k/4k · 备用）',
  },
  'jimeng-image-4.7': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '4.7',
    resolutions: ['2k', '4k'],
    label: '即梦图片 4.7（2k/4k · 备用）',
  },
  'jimeng-image-5.0': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '5.0',
    resolutions: ['2k', '4k'],
    label: '即梦图片 5.0（2k/4k · 备用 · 高画质）',
  },
  'jimeng-image-5.0pro': {
    provider: 'dreamina',
    subcommand: 'text2image',
    model_version: '5.0Pro',
    resolutions: ['1.5k', '2k', '4k'],
    label: '即梦图片 5.0 Pro（1.5k/2k/4k · 备用 · 最强）',
  },
};

/**
 * 即梦积分单价表（成本护栏的数据基础）。
 *
 * source 语义（图片为**档位级**，视频为分辨率级）：
 *   'measured'  —— 实测标定，可信
 *   'estimated' —— 推断值，UI 必须提示「实际以扣费为准」
 *
 * 计费模式差异（实测确认）：
 *   视频按**秒**计费；图片按**次**计费 —— 一次请求返回 4 张候选，故图片成本与 count 无关。
 *
 * 实测来源：CLI 本地任务库 `~/.dreamina_cli/tasks.db` 的 `commerce_info.credit_count`
 * （每笔生成都记录了扣费档位与积分，是比"跑一次最低规格"更省力的标定途径）。
 * 已知实测：图片 3.1/1k = 1（档位 image_basic_generate_plus）、5.0Pro/2k = 8
 * （image_basic_v50_pro_2k）；视频 720p = 5 积分/秒（seedance2.0fast 5s = 25）。
 */
const DREAMINA_CREDIT_COST = {
  video: {
    '480p': { perSecond: 3, source: 'estimated' },
    '720p': { perSecond: 5, source: 'measured' },
    '1080p': { perSecond: 15, source: 'estimated' },
    '4k': { perSecond: 40, source: 'estimated' },
  },
  /**
   * 视频**按模型覆盖**档（优先级高于上面的分辨率默认档）。
   *
   * 为什么需要：同一分辨率下，不同代际/子命令的单价并不相同，
   * 只按分辨率取单一值必然估错，而预估数字正是成本护栏弹给用户看的东西。
   *
   * 实测标定（E06《祖母の椅子》英雄镜头，镜6 / 10s / 720p）：
   *   `seedance2.0`    720p = **8 积分/秒**（10s 实扣 80 积分）
   *   `seedance2.0fast` 720p = 5 积分/秒（沿用 video['720p'] 默认档）
   *   —— **同为 720p 相差 60%**，此前按分辨率估 50 分、实扣 80 分。
   */
  videoByModel: {
    'seedance2.0': { '720p': { perSecond: 8, source: 'measured' } },
    /**
     * seedance2.5：即梦网页端的「**样片模式**」= 该模型 @ 480p
     * （网页原文：先生成 480P 样片，确认满意后可升级为高清正片）。
     * ⚠ **CLI 没有视频升级命令**（子命令里只有 image_upscale），所以走本系统时"升级高清"
     * 只能回即梦网页操作，或在系统里按 720p/1080p 重新生成一版（会再扣一次积分）。
     *
     * 单价来源：即梦网页端显示 5s / 480P / 1 条 = **45 积分** → **9 积分/秒**（2026-09-23 观察）。
     * 720p / 1080p 未实测 → 取「该模型已知最低档(9)」与「通用分辨率档」的**较大值**，宁可高报不低报
     * （历史教训：只按分辨率取单一值曾低报 60%）。
     */
    'seedance2.5': {
      '480p': { perSecond: 9, source: 'estimated' },
      '720p': { perSecond: 9, source: 'estimated' },
      '1080p': { perSecond: 15, source: 'estimated' },
    },
  },
  image: {
    // 实测来源：CLI 本地任务库 ~/.dreamina_cli/tasks.db 的 commerce_info.credit_count
    // （按「次」计费：一次请求返回 4 张候选，与 count 无关）
    'jimeng-image-3.1': {
      perRequest: {
        '1k': { points: 1, source: 'measured' }, // 档位 image_basic_generate_plus
        '2k': { points: 2, source: 'estimated' },
      },
    },
    'jimeng-image-3.0': {
      perRequest: {
        '1k': { points: 1, source: 'estimated' },
        '2k': { points: 2, source: 'estimated' },
      },
    },
    'jimeng-image-4.0': {
      perRequest: {
        '2k': { points: 3, source: 'estimated' },
        '4k': { points: 6, source: 'estimated' },
      },
    },
    'jimeng-image-4.1': {
      perRequest: {
        '2k': { points: 3, source: 'estimated' },
        '4k': { points: 6, source: 'estimated' },
      },
    },
    'jimeng-image-4.5': {
      perRequest: {
        '2k': { points: 3, source: 'estimated' },
        '4k': { points: 6, source: 'estimated' },
      },
    },
    'jimeng-image-4.6': {
      perRequest: {
        '2k': { points: 3, source: 'estimated' },
        '4k': { points: 6, source: 'estimated' },
      },
    },
    'jimeng-image-4.7': {
      perRequest: {
        '2k': { points: 3, source: 'estimated' },
        '4k': { points: 6, source: 'estimated' },
      },
    },
    'jimeng-image-5.0': {
      perRequest: {
        '2k': { points: 3, source: 'estimated' },
        '4k': { points: 6, source: 'estimated' },
      },
    },
    'jimeng-image-5.0pro': {
      perRequest: {
        '1.5k': { points: 4, source: 'estimated' },
        // 档位 image_basic_v50_pro_2k 实测 8 积分/次（此前推断 6，偏低 33%）
        '2k': { points: 8, source: 'measured' },
        '4k': { points: 12, source: 'estimated' },
      },
    },
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

/* 2.5 家族模式（V2.0 已下线，其 V2_MODES 仅保留供历史数据解析） */
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
  DREAMINA_VIDEO_COMMANDS,
  DREAMINA_IMAGE_DEFAULT_MODEL,
  DREAMINA_IMAGE_RATIOS,
  DREAMINA_CREDIT_COST,
  DREAMINA_DEFAULT_THRESHOLD,
  providerOf,
  RETIRED_MODELS,
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
