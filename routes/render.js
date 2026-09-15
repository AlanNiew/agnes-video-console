'use strict';
/**
 * routes/render.js —— 成片渲染：发起 / 任务列表 / 详情 / 删除 / 作品库（v1.9.1 拆分自 server.js）
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projects, renders } = require('../db');
const renderer = require('../workers/render');
const { log } = require('../core/logger');
const { RENDER_PARAMS_DEFAULTS, probeDuration } = require('../core/config');
const { RENDER_TRANSITIONS, SUBTITLE_STYLES, SUBTITLE_POSITIONS } = require('../core/constants');
const { ApiError, ah } = require('../core/errors');
const { WORKS_DIR, ARTIFACTS_DIR } = require('../lib/artifacts');

/** v2.5：ffprobe 指定流时长（秒）——用于"音视频流时长对比"（音频短于视频 = 尾部静音） */
function streamDuration(file, kind) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', `${kind}:0`, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  );
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** v2.5：客观视频指标（供 AI/人工筛查可疑镜头）——亮度均值与波动、单帧亮度跳变占比、帧间差（运动幅度） */
function computeVideoMetrics(file) {
  const run = (vf) => {
    const r = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vf', vf, '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 240_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    return [...String(r.stdout || '').matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  };
  const y = run('scale=160:-2,signalstats,metadata=print:file=-');
  const d = run('scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:file=-');
  if (!y.length) return null;
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const std = Math.sqrt(y.reduce((a, b) => a + (b - mean) ** 2, 0) / y.length);
  const diffs = y.slice(1).map((v, i) => Math.abs(v - y[i]));
  const flashRatio = diffs.length ? diffs.filter((x) => x > 18).length / diffs.length : 0;
  const motion = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  return {
    luma_mean: +mean.toFixed(1), // 平均亮度（0–255）
    luma_std: +std.toFixed(1), // 亮度波动（越大越"跳"）
    flash_ratio: +flashRatio.toFixed(3), // 单帧亮度跳变 >18/255 的占比（闪烁候选）
    motion_mean: motion === null ? null : +motion.toFixed(1), // 帧间差均值（运动幅度）
    sampled_frames: y.length,
  };
}

module.exports = function registerRenderRoutes(app) {
  /* ---------- v2.2 作品库：data/works 下全部成品（成片/海报/字幕/台词）汇总清单 ---------- */
  // 按作品目录扫描（项目可能已删除——目录名《名》-id 解析；删除项目保留作品，库中仍可见可下载）
  app.get('/api/works', (req, res) => {
    const items = [];
    let dirs = [];
    try {
      dirs = fs
        .readdirSync(WORKS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      /* 目录不存在 → 空库 */
    }
    for (const dirName of dirs) {
      const dir = path.join(WORKS_DIR, dirName);
      const m = /^(?:《(.*)》)?-(\d+)$/.exec(dirName) || /^(.*)-(\d+)$/.exec(dirName);
      const projectId = m ? Number(m[2]) : null;
      // 目录内清单：成片按名称倒序（新版本在前），海报/台词各取最新
      let files;
      try {
        files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
      } catch {
        continue;
      }
      const films = files
        .filter((f) => /^成片-.*\.mp4$/.test(f))
        .map((f) => fileEntry(dir, dirName, f))
        .sort((a, b) => b.mtime - a.mtime);
      if (!films.length) continue; // 无成片的半成品目录不入库
      const posters = files.filter((f) => /^海报.*\.png$/.test(f)).map((f) => fileEntry(dir, dirName, f));
      const subtitles = files
        .filter((f) => /^字幕-.*\.srt$/.test(f))
        .map((f) => fileEntry(dir, dirName, f))
        .sort((a, b) => b.mtime - a.mtime);
      const scripts = files.filter((f) => /^旁白台词\.txt$/.test(f)).map((f) => fileEntry(dir, dirName, f));
      // 质检报告：从最新一条该项目的渲染任务取（成片版本与任务 ID 对应）
      let quality = null;
      let latestRenderAt = null;
      try {
        const job = (renders.listByProject(projectId) || []).find(
          (j) => j.status === 'completed' && films.some((f) => f.name === `成片-${j.id}.mp4`),
        );
        if (job) {
          quality = job.quality;
          latestRenderAt = job.updated_at;
        }
      } catch {
        /* 项目已删/任务已删 → 质检为空，作品仍展示 */
      }
      const proj = projectId ? projects.get(projectId) : null;
      items.push({
        project_id: projectId,
        // 项目名优先取活项目（重命名后目录名不追改），否则目录名
        name: proj?.name || (m ? m[1] : dirName),
        work_dir: dir,
        latest_at: latestRenderAt || films[0].mtime,
        quality,
        films,
        poster: posters.sort((a, b) => b.mtime - a.mtime)[0] || null,
        subtitles,
        script: scripts[0] || null,
      });
    }
    items.sort((a, b) => b.latest_at - a.latest_at);
    res.json({ items, total: items.length });
  });

  // 发起渲染：{transition_ms?, transition_type?, narration_offset_ms?, title_card?, end_card?,
  //           subtitle_style?, subtitle_position?, bgm_*, narration_volume?, burn_subtitles?, aspect?}
  // → 渲染任务（后台执行）
  app.post(
    '/api/projects/:id/render',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      if (!renderer.hasFfmpeg()) throw new ApiError(400, '未检测到 ffmpeg（需安装并加入 PATH）才能渲染成片');
      const b = req.body || {};
      // v2.2.2：参数越界不再静默钳制——直接 400 提示合法范围（用户能立刻知道填错了什么）
      const parseIntRange = (v, lo, hi, dft, label) => {
        if (v === undefined || v === null || v === '') return dft;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new ApiError(400, `${label} 需为数字（收到：${v}）`);
        const r = Math.round(n);
        if (r < lo || r > hi) throw new ApiError(400, `${label} 需在 ${lo}–${hi} 之间（收到：${r}）`);
        return r;
      };
      const parseNumRange = (v, lo, hi, dft, label) => {
        if (v === undefined || v === null || v === '') return dft;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new ApiError(400, `${label} 需为数字（收到：${v}）`);
        if (n < lo || n > hi) throw new ApiError(400, `${label} 需在 ${lo}–${hi} 之间（收到：${n}）`);
        return n;
      };
      const params = {
        transition_ms: parseIntRange(
          b.transition_ms,
          200,
          2000,
          RENDER_PARAMS_DEFAULTS.transition_ms,
          '转场时长 transition_ms',
        ),
        narration_offset_ms: parseIntRange(
          b.narration_offset_ms,
          0,
          3000,
          RENDER_PARAMS_DEFAULTS.narration_offset_ms,
          '旁白偏移 narration_offset_ms',
        ),
        title_card: b.title_card === undefined ? RENDER_PARAMS_DEFAULTS.title_card : Boolean(b.title_card),
        end_card: b.end_card === undefined ? RENDER_PARAMS_DEFAULTS.end_card : Boolean(b.end_card),
        // v2.0 转场类型（xfade 白名单）
        transition_type: RENDER_TRANSITIONS.includes(String(b.transition_type))
          ? String(b.transition_type)
          : RENDER_PARAMS_DEFAULTS.transition_type,
        // v2.0 字幕样式 / 位置
        subtitle_style: SUBTITLE_STYLES.includes(String(b.subtitle_style))
          ? String(b.subtitle_style)
          : RENDER_PARAMS_DEFAULTS.subtitle_style,
        subtitle_position: SUBTITLE_POSITIONS.includes(String(b.subtitle_position))
          ? String(b.subtitle_position)
          : RENDER_PARAMS_DEFAULTS.subtitle_position,
        // v1.4 BGM
        bgm_volume: parseNumRange(b.bgm_volume, 0, 1, 0.35, 'BGM 音量 bgm_volume'),
        bgm_duck: b.bgm_duck === undefined ? true : Boolean(b.bgm_duck),
        // v2.4.1 BGM 起始偏移（毫秒）：跳过音源开头的静音 padding / 爆音段
        bgm_start_ms: parseIntRange(
          b.bgm_start_ms,
          0,
          10000,
          RENDER_PARAMS_DEFAULTS.bgm_start_ms,
          'BGM 起始偏移 bgm_start_ms',
        ),
        // v2.5 镜头原声（AI 环境声）混入音量：0 = 剥离（默认），>0 低音量混入
        ambient_volume: parseNumRange(
          b.ambient_volume,
          0,
          1,
          RENDER_PARAMS_DEFAULTS.ambient_volume,
          '镜头原声音量 ambient_volume',
        ),
        // v1.5 旁白增益
        narration_volume: parseNumRange(b.narration_volume, 0.5, 3, 1.4, '旁白音量 narration_volume'),
        // v1.6 字幕烧录
        burn_subtitles: b.burn_subtitles === undefined ? true : Boolean(b.burn_subtitles),
        subtitle_fontsize: parseIntRange(b.subtitle_fontsize, 24, 72, 42, '字幕字号 subtitle_fontsize'),
        // v2.4 片头/片尾卡文字：署名（creator）+ 主/副标题（未传时由项目名拆分）
        creator:
          b.creator === undefined || b.creator === null
            ? RENDER_PARAMS_DEFAULTS.creator
            : String(b.creator).trim().slice(0, 40),
        title: b.title === undefined || b.title === null ? null : String(b.title).trim().slice(0, 60) || null,
        subtitle:
          b.subtitle === undefined || b.subtitle === null ? null : String(b.subtitle).trim().slice(0, 60) || null,
        // v1.8 成片方向：显式参数 > 项目画幅 > 默认横屏
        aspect: ['16:9', '9:16'].includes(String(b.aspect))
          ? String(b.aspect)
          : p.aspect_ratio === '9:16'
            ? '9:16'
            : '16:9',
      };
      const collected = renderer.collectSegments(p.id);
      const ready = collected ? collected.segments.length : 0;
      if (ready < 2) throw new ApiError(400, `至少需要 2 个已完成视频的镜头才能渲染成片（当前 ${ready} 个）`);
      const jobId = renders.insert({ project_id: p.id, params });
      log(
        'info',
        `项目 #${p.id} 发起渲染任务 #${jobId}（${ready} 镜，转场 ${params.transition_type} ${params.transition_ms}ms，旁白偏移 ${params.narration_offset_ms}ms）`,
      );
      res.status(201).json(renders.get(jobId));
    }),
  );

  // 项目渲染任务列表
  app.get('/api/projects/:id/render/jobs', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    res.json({ items: renders.listByProject(p.id) });
  });

  // 渲染任务详情
  app.get('/api/render/jobs/:id', (req, res) => {
    const job = renders.get(req.params.id);
    if (!job) throw new ApiError(404, '渲染任务不存在');
    res.json(job);
  });

  // v2.5 渲染质检：关键帧 4 张 + 音频波形图（按需生成并缓存）+ 流时长对比 + 客观指标（亮度/闪烁/运动）
  app.get(
    '/api/render/jobs/:id/inspect',
    ah(async (req, res) => {
      const job = renders.get(req.params.id);
      if (!job) throw new ApiError(404, '渲染任务不存在');
      if (job.status !== 'completed' || !job.output_path || !fs.existsSync(job.output_path)) {
        throw new ApiError(400, '仅已完成的渲染任务可质检');
      }
      const src = job.output_path;
      const mk = (name, args) => {
        const out = path.join(ARTIFACTS_DIR, name);
        if (!fs.existsSync(out)) {
          const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, out], {
            timeout: 120_000,
            windowsHide: true,
          });
          if (r.status !== 0 || !fs.existsSync(out)) return null;
        }
        return '/artifacts/' + path.basename(out);
      };
      const dur = probeDuration(src) || 0;
      const pts = [0.06, 0.34, 0.64, 0.92].map((r) => Math.max(0.1, +(dur * r).toFixed(2)));
      const frames = pts
        .map((t, i) => {
          const url = mk(`inspect-${job.id}-f${i + 1}.png`, [
            '-ss',
            String(t),
            '-i',
            src,
            '-frames:v',
            '1',
            '-vf',
            'scale=640:-2',
          ]);
          return url ? { at_s: t, url } : null;
        })
        .filter(Boolean);
      const wave = mk(`inspect-${job.id}-wave.png`, [
        '-i',
        src,
        '-filter_complex',
        'showwavespic=s=1200x260:colors=0x6EC1FF[wf];color=c=0x0A0E14:s=1200x260[bg];[bg][wf]overlay',
        '-frames:v',
        '1',
      ]);
      const videoS = streamDuration(src, 'v');
      const audioS = streamDuration(src, 'a');
      const metrics = computeVideoMetrics(src);
      res.json({
        ok: true,
        job_id: job.id,
        duration_s: dur,
        video_stream_s: videoS,
        audio_stream_s: audioS,
        audio_gap_s: videoS !== null && audioS !== null ? Math.round((videoS - audioS) * 100) / 100 : null,
        frames,
        wave,
        metrics,
        hints: [
          videoS !== null && audioS !== null && videoS - audioS > 0.5
            ? `⚠️ 音频流比视频短 ${(videoS - audioS).toFixed(2)}s（尾部可能静音）`
            : '✅ 音视频流等长',
          metrics && metrics.flash_ratio > 0.25
            ? `⚠️ 亮度跳变帧占比 ${(metrics.flash_ratio * 100).toFixed(0)}%（可能闪烁）`
            : null,
        ].filter(Boolean),
      });
    }),
  );

  // 删除渲染任务（渲染中不可删；artifacts 渲染缓存清理；**作品目录 data/works 保留**——作品是用户劳动成果）
  app.delete('/api/render/jobs/:id', (req, res) => {
    const job = renders.get(req.params.id);
    if (!job) throw new ApiError(404, '渲染任务不存在');
    if (job.status === 'rendering') throw new ApiError(400, '渲染进行中，暂不能删除');
    if (job.output_path) {
      try {
        fs.rmSync(job.output_path, { force: true });
      } catch {
        /* ignore */
      }
    }
    renders.remove(job.id);
    res.json({ ok: true });
  });
};

/** /api/works 条目内文件描述：名称 / 下载 URL（目录与文件名各自 encodeURIComponent）/ 大小 / 修改时间 */
function fileEntry(dir, dirName, fileName) {
  let size = 0;
  let mtime = 0;
  try {
    const st = fs.statSync(path.join(dir, fileName));
    size = st.size;
    mtime = Math.round(st.mtimeMs);
  } catch {
    /* ignore */
  }
  return {
    name: fileName,
    url: `/works/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`,
    size_kb: Math.round(size / 1024),
    mtime,
  };
}
