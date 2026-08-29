'use strict';
/**
 * openapi.js —— 控制台 API 自描述（v1.3）
 * GET /api/openapi.json 返回轻量 OpenAPI 3.0 文档：路径 + 方法 + 摘要 + 关键字段说明。
 * 目标：让自动化脚本 / AI Agent 不必读源码即可正确对接（例如完成任务字段是
 * metadata_url / video_local_url，提交接口为「入队」语义等）。
 */
const pkg = require('./package.json');

const paths = {
  '/api/health': { get: '健康检查（ok/uptime/db 路径/node 版本）' },
  '/api/meta': {
    get: '模型/画幅/时长/图片清单元数据（前端下拉单一事实来源）；models[].rate_limit 为上游限流提示',
  },
  '/api/openapi.json': { get: '本文档' },
  '/api/settings': {
    get: '获取设置（api_key/fish_api_key 仅返回掩码）',
    put: '保存设置；可变字段：api_key、base_url、model、poll_interval_ms(500-60000)、max_active_minutes(1-1440)、submit_interval_ms(0-300000，服务端提交队列节流)、fish_api_key、fish_voice、fish_speed(0.5-2)',
  },
  '/api/stats': { get: '按状态统计 {total, active, byStatus, completed, failed}' },
  '/api/logs': { get: '最近运行日志 ?limit=' },
  '/api/tasks': {
    get: '任务列表 ?status=&q=&limit=&offset=；completed 任务含 metadata_url（远端）与 video_local_url（本地归档，优先使用）',
    post: '创建任务（入队语义：返回 queued 记录，由后台提交器按 submit_interval_ms 节流提交上游，429 自动退避重试）。body：{model, prompt, mode(text|keyframe|reference), seconds("4"-"12"), size, aspect_ratio, seed?, first_frame?, last_frame?, images?[], audios?[], videos?[]}；模式规则：text 不允许媒体字段；keyframe 需 first/last_frame；reference 需 images/audios/videos 至少一类，flash 限 5 图且不支持 videos',
  },
  '/api/tasks/{id}': { get: '任务详情', delete: '删除任务记录' },
  '/api/tasks/{id}/retry': { post: '失败重试（以原参数入队新任务，保留失败记录）' },
  '/api/tasks/{id}/poll': { post: '立即强制轮询一次（需已有 video_id）' },
  '/api/tasks/bulk/clear-completed': { post: '清空已完成' },
  '/api/tasks/bulk/clear-failed': { post: '清空 failed 与 submit_error' },
  '/api/llm/chat': { post: '通用文本生成 {system?, messages[], temperature?, max_tokens?} → {content}' },
  '/api/llm/script': { post: '创意 → 结构化文案 {idea, style?, aspect_ratio?, seconds?, project_id?, auto_select?}' },
  '/api/llm/storyboard': {
    post: '创意 → 多镜头分镜（每镜头含 seq/title/video_prompt/narration/seconds；narration 为该镜旁白文案），可关联项目重建镜头工作副本',
  },
  '/api/images/generate': {
    post: '图片生成（同步）{prompt, size(1K-4K), ratio, count(1-4), kind(character|scene), project_id?} → {results[], image}',
  },
  '/api/projects': { get: '项目列表', post: '创建项目 {name, idea?, style?, aspect_ratio?, seconds?}' },
  '/api/projects/{id}': {
    get: '项目详情聚合 {project, texts, images, shots, tasks, tts}；tasks[] 中同镜头已有 completed 时，旧 failed/submit_error 打 superseded:true',
    patch: '更新项目 {name?, idea?, style?, aspect_ratio?, seconds?, status?}',
    delete: '删除项目（级联清理文案/图片/镜头/配音/渲染任务，任务解绑）',
  },
  '/api/projects/{id}/select-text': { post: '选定文案版本 {text_id}' },
  '/api/projects/{id}/texts/{textId}': { patch: '编辑文案内容 {content}' },
  '/api/projects/{id}/select-image': { post: '定稿角色/场景图 {image_id}' },
  '/api/projects/{id}/storyboard/apply': { post: '选用历史分镜版本 {text_id}（重建镜头）' },
  '/api/projects/{id}/shots': {
    get: '(经项目详情返回) 镜头列表：{id, seq, title, video_prompt, narration, seconds, mode, use_character_ref}',
    post: '添加镜头 {title?, video_prompt, narration?, seconds?, mode?(reference|text), use_character_ref?(默认 true；false = 纯空镜，text 模式提交不引用角色图)}',
  },
  '/api/projects/{id}/shots/{shotId}': {
    patch: '编辑镜头 {title?, video_prompt?, narration?, seconds?, use_character_ref?}',
    delete: '删除镜头（任务保留）',
  },
  '/api/projects/{id}/shots/reorder': { post: '镜头排序 {ids[]}' },
  '/api/projects/{id}/shots/{shotId}/videos': {
    post: '单镜头提交视频任务（入队语义）。镜头 use_character_ref=false 或 mode=text → 纯文生模式；否则引用角色定稿图并自动注入 <Picture 1> 前缀',
  },
  '/api/projects/{id}/videos': { post: '整项目提交视频任务（旧入口，单提示词）' },
  '/api/projects/{id}/render': {
    post: '一键成片渲染：镜头视频（本地归档优先）+ 逐镜旁白（每镜头最新成功的 shot 配音）+ 项目 BGM（可选）→ xfade 叠化 + 旁白对齐混音 + BGM 循环铺底/淡入淡出/旁白闪避 + 旁白字幕烧录（ASS）→ 1280x720@30 mp4。body：{transition_ms?(200-2000, 默认600), narration_offset_ms?(0-3000, 默认500), title_card?(默认true), end_card?(默认true), bgm_volume?(0-1, 默认0.35), bgm_duck?(默认true), narration_volume?(0.5-3, 默认1.4), burn_subtitles?(默认true), subtitle_fontsize?(24-72, 默认42)}；需本机 ffmpeg，≥2 个已完成镜头',
  },
  '/api/projects/{id}/render/jobs': { get: '项目渲染任务列表' },
  '/api/render/jobs/{id}': {
    get: '渲染任务详情 {status(queued|rendering|completed|failed), progress(0-100), output_path, output_url}',
    delete: '删除渲染任务（渲染中不可删；产物文件一并清理）',
  },
  '/api/music/search': { get: 'BGM 在线曲库搜索 ?keyword=&limit= → {items:[{id,name,artist,album,duration_s,cover,levels[]}]}（需设置 music_api_base）' },
  '/api/music/stream': { get: '歌曲试听流代理 ?id=&level=（播放地址有时效性，服务端现取现转发）' },
  '/api/projects/{id}/bgm': {
    post: '项目选用 BGM {song_id(纯数字), name, artist?, album?, level?} → 立即下载缓存到 artifacts 并落库 projects.bgm',
    delete: '清除项目 BGM 选择（本地缓存文件保留）',
  },
  '/api/tts/generate': {
    post: 'Fish Audio 配音合成 {text, project_id?, shot_id?(提供时 kind 自动为 shot，成片渲染按镜头取用), kind?(narration|shot), voice?, speed?, model?} → mp3 落地 artifacts',
  },
  '/api/tts/voices': { get: '音色清单与可用模型' },
  '/api/tts/{id}/select': { post: '选用配音记录' },
  '/api/tts/{id}/bind': { post: '绑定/解绑旁白到镜头 {project_id?, shot_id(数字=绑定并转 shot kind；null=解绑为 narration)}；同镜头互斥自动让位，成片渲染按镜头对齐混入' },
  '/api/tts/{id}': { delete: '删除配音记录（本地文件一并清理）' },
  '/artifacts/*': { get: '本地产物静态服务（图片/视频/音频/成片）' },
};

function buildOpenApi(baseUrl) {
  const pathsOut = {};
  for (const [p, methods] of Object.entries(paths)) {
    pathsOut[p] = {};
    for (const [m, summary] of Object.entries(methods)) {
      pathsOut[p][m] = {
        summary,
        description: summary,
        tags: [p.includes('/render') ? 'render' : p.includes('/tts') ? 'tts' : p.includes('/projects') ? 'projects' : 'core'],
      };
    }
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Agnes Video Console API',
      version: pkg.version,
      description: '本地 AI 视频创作控制台。要点：① 任务创建为「入队」语义，后台提交器按 submit_interval_ms 服务端节流并自动重试 429；② 完成视频自动归档本地，播放/下载优先 video_local_url；③ 成片渲染把镜头视频与逐镜旁白合成为完整短片。',
    },
    servers: [{ url: baseUrl }],
    paths: pathsOut,
  };
}

module.exports = { buildOpenApi };
