'use strict';
/**
 * config.js —— 全局单源常量与共享工具（v1.9.1 重构）
 * 消除多文件重复定义/漂移：
 *   - DEFAULT_BASE_URL：上游默认地址（原 db.js / submitter.js / poller.js / agnes.js 四处硬编码）
 *   - probeDuration：ffprobe 时长探测（原 server.js / render.js 双实现已漂移，统一为 render.js 版本）
 *   - RENDER_PARAMS_DEFAULTS：成片渲染参数默认值（原 server.js 与渲染侧双定义靠人工同步）
 * 注意：此文件必须保持零依赖（仅 node 内置），可被任何模块安全 require。
 */
const { spawnSync } = require('node:child_process');

/** Agnes 上游 API 默认地址（各处 settings.get('base_url', ...) 的兜底值唯一来源） */
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com';

/** 成片渲染参数默认值（服务端参数校验与渲染器共用同一份） */
const RENDER_PARAMS_DEFAULTS = {
  transition_ms: 600,
  narration_offset_ms: 500,
  title_card: true,
  end_card: true,
  transition_type: 'fade',
  subtitle_style: 'white-outline',
  subtitle_position: 'bottom',
};

/** ffprobe 探测媒体时长（秒，保留两位小数）；ffprobe 不存在/失败时返回 null 不阻塞 */
function probeDuration(filePath) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout) {
      const d = Number(r.stdout.trim());
      return Number.isFinite(d) && d > 0 ? Math.round(d * 100) / 100 : null;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  RENDER_PARAMS_DEFAULTS,
  probeDuration,
};
