'use strict';
/**
 * services/prompts.js —— AI 提示词模板与 LLM 输出处理（v1.9.1 拆分自 server.js）
 * 纯函数、可单测：不持有 IO，不依赖 express。
 * 依赖 constants 的白名单（SECONDS_OK / MAX_SHOTS / MAX_TEXT_LEN）做规范化兜底。
 */
const { SECONDS_OK, MAX_SHOTS, MAX_TEXT_LEN } = require('../constants');

/** 文案生成系统提示词：严格输出结构化 JSON（mock 测试按「JSON 对象」契约标记识别） */
const SCRIPT_SYSTEM_PROMPT = `你是资深影视导演兼 AI 视频提示词工程师。根据用户创意，产出可直接驱动 AI 视频生成的专业文案。
只输出一个 JSON 对象（不要 markdown 代码块、不要注释、不要任何解释），字段如下：
{
  "script": "故事梗概，100~150 字。结构：一句话交代主角与目标 → 两句冲突与转折 → 一句情绪落点。必须用具象画面与动作叙述，禁止「展现了」「体现了」这类抽象概括",
  "video_prompt": "视频生成提示词，150~220 字，六段式按序书写：①主体与场景（谁、在哪、外观关键特征）②动作与变化（2~3 个有先后顺序的连续动作）③镜头语言（景别：特写/中景/全景 + 运镜：推/拉/摇/移/跟 + 转场方式）④光线与色调（时段、光源方向、色温冷暖）⑤视觉风格与画质（写实/胶片/动漫等 + 高细节、电影感等关键词）⑥声音与节奏（环境声、关键音效点、节奏快慢）。必须以「以 <Picture 1> 中的角色为参考，保持其外观一致」开头。每句都要具体可拍摄，禁止堆砌抽象形容词",
  "character_desc": "主角外观设定（供 AI 角色立绘生成），120 字内，必含：性别年龄、发型发色、五官特征、表情气质、服装款式与颜色、体型、有辨识度的配饰。不要写与场景、剧情相关的内容",
  "scene_desc": "主场景描述，100 字内：地点类型、时段与光源、天气、色调氛围、一处标志性陈设或地物"
}
自洽性要求：character_desc 与 video_prompt 中的角色外观一致；scene_desc 与 script 的时空一致；video_prompt 的动作量与目标时长匹配（5 秒最多 2~3 个动作）。`;

/** 分镜生成系统提示词：输出 shots 数组的结构化 JSON（mock 测试按 "shots" 契约标记识别） */
const STORYBOARD_SYSTEM_PROMPT = `你是资深影视分镜师。把用户的创意拆解为节奏完整、镜头间可无缝衔接的分镜脚本。
只输出一个 JSON 对象（不要 markdown 代码块、不要注释），结构如下：
{
  "shots": [
    {
      "seq": 1,
      "title": "镜头标题，8 字内，格式如「开场·麦田全景」「转折·回眸特写」",
      "video_prompt": "该镜头的视频生成提示词，150~200 字，六段式按序书写：①景别与运镜（如：大全景，镜头缓慢推进）②主体与动作（角色在做什么，动作设计需能自然衔接下一镜）③环境与细节（具体可拍的地物、道具）④光线与色调（时段、光源方向、色温）⑤视觉风格（全片统一的关键词）⑥声音与节奏。有角色出镜的镜头必须以「以 <Picture 1> 中的角色为参考，保持其外观一致」开头；纯环境/空镜/无角色镜头直接从景别写起，不要提及 <Picture 1>",
      "narration": "该镜头的旁白文案，15~40 字，讲述式语气，与画面互补而非复述画面内容：推进叙事、交代背景或点染情绪；全片旁白连起来应是一篇完整的短文",
      "seconds": "5"
    }
  ]
}
分镜节奏要求：第一镜负责建立时空（交代环境与主角出场），中间镜头递进冲突或细节，最后一镜收束情绪；相邻镜头的动作与视线方向连贯（遵守 180° 轴线，不越轴）；全片视觉风格关键词完全一致；seconds 只能是 "4"~"12" 的字符串；动作量与该镜时长匹配（5 秒最多 2~3 个动作）；镜头数量遵循用户指定数量（未指定则按叙事需要 3~8 个）。`;

/** 容错解析 LLM 输出 JSON：剥 markdown 围栏 → 提取首个平衡对象 → JSON.parse */
function parseLLMJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 去掉 ```json ... ``` 围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* 继续尝试提取对象 */ }
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 规范化分镜数组（LLM 输出 / 历史 storyboard 版本通用）：重编 seq、裁剪长度、seconds 白名单兜底 */
function normalizeStoryboardShots(rawShots, fallbackSeconds = '5') {
  const fb = SECONDS_OK.includes(String(fallbackSeconds)) ? String(fallbackSeconds) : '5';
  const out = [];
  for (const s of (rawShots || []).slice(0, MAX_SHOTS)) {
    const vp = String(s?.video_prompt || '').trim();
    if (!vp) continue; // 空提示词镜头直接丢弃
    out.push({
      seq: out.length + 1,
      title: String(s?.title || '').trim().slice(0, 100) || null,
      video_prompt: vp.slice(0, MAX_TEXT_LEN),
      narration: String(s?.narration || '').trim().slice(0, 200) || null, // v1.3 镜头旁白
      seconds: SECONDS_OK.includes(String(s?.seconds)) ? String(s.seconds) : fb,
      mode: 'reference',
    });
  }
  return out;
}

module.exports = {
  SCRIPT_SYSTEM_PROMPT,
  STORYBOARD_SYSTEM_PROMPT,
  parseLLMJson,
  normalizeStoryboardShots,
};
