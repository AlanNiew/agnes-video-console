'use strict';
/**
 * db/repos/settings.js —— settings 表仓库（M3-P3）
 */
const stmts = require('../sql');

const settings = {
  get(key, fallback = null) {
    const r = stmts.getSetting.get(key);
    return r ? r.value : fallback;
  },
  set(key, value) {
    stmts.setSetting.run(key, String(value));
  },
};

/** 默认设置（与文档对齐） */
const { DEFAULT_BASE_URL } = require('../../core/config');

const DEFAULT_SETTINGS = {
  base_url: DEFAULT_BASE_URL,
  model: 'agnes-video-2.5-flash',
  poll_interval_ms: '2000',
  max_active_minutes: '20',
  submit_interval_ms: '60000', // M2：批量分镜提交间隔（0 = 连续提交）
  fish_api_key: '', // TTS：Fish Audio API Key（可选；不配置则配音功能不可用）
  fish_voice: 'default', // TTS：默认音色（default = 平台默认；或 Fish 音色库模型 id）
  fish_speed: '1', // TTS：默认语速 0.5–2.0
  music_api_base: '', // v1.4 BGM：音乐接口地址（如 http://127.0.0.1:15001；留空则 BGM 功能不可用）
  music_api_token: '', // v1.4 BGM：音乐接口 Token（Authorization 头，仅服务端使用）
  music_level: 'exhigh', // v1.4 BGM：默认音质 standard/exhigh/lossless/hires
  fish_web_token: '', // v1.9 声音广场：fish.audio 网页端 Token（浏览社区音色；仅服务端使用）
  tts_voice_pool: '[]', // v1.9 音色备选池（JSON 数组：从声音广场收录的真实音色）
  video_auto_download: '0', // v2.3 视频完成后自动下载到本地（'1'开/'0'关；默认关——本地产物很占磁盘，关时仅保留平台链接）
  creation_templates: '[]', // P2-7 创作模板（JSON 数组：创意写法 + 风格 + 画幅/时长 + 成片预设配方）
  character_library: '[]', // v2.5 角色库（JSON 数组：跨项目复用的角色资产——名/图/服色锚/提示词/所属系列）
  dreamina_confirm_threshold: '10', // 即梦成本护栏：预估积分 > 此阈值时前端需弹窗确认（0 = 每次即梦调用都确认）
  dreamina_auto_character: '1', // 全自动成片的角色图阶段用即梦主力档（1 积分/次 ≈ 4 张候选）；'0' = 用 Agnes 免费档
  dreamina_fallback: '1', // v2.6.1 即梦不可用/失败时**自动改投免费档**（积分不足 / 生成失败 / 非 VIP / 环境未就绪）；'0' = 保留旧的退避等人工
  dreamina_agnes_fallback: '0', // v2.6.7 **反向回退**：Agnes 免费档排队失败（503/429/网络重试耗尽）时自动改投即梦 seedance2.0mini；默认 '0'（会消耗会员积分，须显式开启）
  dreamina_ref_strategy: 'first-frame', // v2.6.9 反向回退里参考图的传法：first-frame=取首张作首帧（image2video，**实测唯一能出片**）/ multimodal=全能参考（multimodal2video，实测即梦侧失败，待其修复再切）
};
module.exports = { settings, DEFAULT_SETTINGS };
