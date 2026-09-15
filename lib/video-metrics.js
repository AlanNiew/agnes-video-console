'use strict';
/**
 * lib/video-metrics.js —— v2.5 视频客观指标（供渲染质检与镜头级筛查共用）
 * 只用 ffmpeg/ffprobe 计算，不需要视觉模型：
 *   - luma_mean / luma_std：平均亮度与亮度波动（越大越"跳"）
 *   - flash_ratio：单帧亮度跳变 >18/255 的占比（闪烁候选）
 *   - motion_mean：帧间差均值（运动幅度）
 * 用途：成片质检（routes/render.js inspect）与镜头级"可疑镜头"筛查（routes/tasks.js）。
 */
const { spawnSync } = require('node:child_process');

/** ffprobe 指定流时长（秒）；失败返回 null */
function streamDuration(file, kind) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', `${kind}:0`, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** 逐帧亮度序列 → 客观指标；无 ffmpeg/无帧时返回 null */
function computeVideoMetrics(file, { timeoutMs = 240_000 } = {}) {
  const run = (vf) => {
    const r = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vf', vf, '-f', 'null', '-'],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return [...String(r.stdout || '').matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  };
  const y = run('scale=160:-2,signalstats,metadata=print:file=-');
  if (!y.length) return null;
  const d = run('scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:file=-');
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const std = Math.sqrt(y.reduce((a, b) => a + (b - mean) ** 2, 0) / y.length);
  const diffs = y.slice(1).map((v, i) => Math.abs(v - y[i]));
  const flashRatio = diffs.length ? diffs.filter((x) => x > 18).length / diffs.length : 0;
  const motion = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  return {
    luma_mean: +mean.toFixed(1),
    luma_std: +std.toFixed(1),
    flash_ratio: +flashRatio.toFixed(3),
    motion_mean: motion === null ? null : +motion.toFixed(1),
    sampled_frames: y.length,
  };
}

module.exports = { streamDuration, computeVideoMetrics };
