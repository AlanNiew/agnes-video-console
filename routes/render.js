'use strict';
/**
 * routes/render.js —— 成片渲染：发起 / 任务列表 / 详情 / 删除 / 作品库（v1.9.1 拆分自 server.js）
 */
const fs = require('node:fs');
const path = require('node:path');
const { projects, renders } = require('../db');
const renderer = require('../render');
const { log } = require('../logger');
const { RENDER_PARAMS_DEFAULTS } = require('../config');
const { RENDER_TRANSITIONS, SUBTITLE_STYLES, SUBTITLE_POSITIONS } = require('../constants');
const { ApiError, ah } = require('../errors');
const { WORKS_DIR } = require('../artifacts');

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
      const clampInt = (v, lo, hi, dft) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : dft;
      };
      const bgmVol = Number(b.bgm_volume);
      const narrVol = Number(b.narration_volume);
      const params = {
        transition_ms: clampInt(b.transition_ms, 200, 2000, RENDER_PARAMS_DEFAULTS.transition_ms),
        narration_offset_ms: clampInt(b.narration_offset_ms, 0, 3000, RENDER_PARAMS_DEFAULTS.narration_offset_ms),
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
        bgm_volume: Number.isFinite(bgmVol) ? Math.min(Math.max(bgmVol, 0), 1) : 0.35,
        bgm_duck: b.bgm_duck === undefined ? true : Boolean(b.bgm_duck),
        // v1.5 旁白增益
        narration_volume: Number.isFinite(narrVol) ? Math.min(Math.max(narrVol, 0.5), 3) : 1.4,
        // v1.6 字幕烧录
        burn_subtitles: b.burn_subtitles === undefined ? true : Boolean(b.burn_subtitles),
        subtitle_fontsize: clampInt(b.subtitle_fontsize, 24, 72, 42),
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
