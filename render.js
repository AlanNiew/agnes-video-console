'use strict';
/**
 * render.js —— 一键成片渲染器（v1.3）
 * 把项目的镜头视频 + 逐镜旁白渲染为一部完整短片：
 *   [片头卡] + 镜头1..N（xfade 叠化）+ [片尾卡]，旁白按镜头起幅点对齐混入。
 * 配方为生产验证过的两遍式流程：
 *   1) 各段归一化 1280x720@30 无声（消除分辨率/帧率差异）
 *   2) xfade 链式叠化 + adelay 旁白 + amix + alimiter 一遍合成
 * 进度经 ffmpeg -progress 回写 render_jobs.progress。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projects, renders } = require('./db');
const { ARTIFACTS_DIR } = require('./artifacts');
const { log } = require('./logger');

const TICK_MS = 1500;
const OUT_W = 1280;
const OUT_H = 720;
const OUT_FPS = 30;
const TITLE_DUR = 2.8;
const END_DUR = 3.5;

/** 简易中文字符检测（用于字体能力降级） */
function hasCJK(s) { return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(s || '')); }

/** 运行时可用的字体（优先中文字体；找不到返回 null） */
function findFont() {
  const candidates = [
    'C:/Windows/Fonts/msyhbd.ttc',
    'C:/Windows/Fonts/msyh.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  ];
  for (const f of candidates) {
    try { if (fs.existsSync(f)) return f; } catch { /* ignore */ }
  }
  return null;
}

function hasFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function probeDuration(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const d = Number(r.stdout.trim());
      return Number.isFinite(d) && d > 0 ? d : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** promisified ffmpeg 运行（可选 -progress 回调，onProgressPct(0-1)） */
function runFfmpeg(args, { onProgress = null, totalMs = 0, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', ...args],
      { windowsHide: true, cwd });
    let err = '';
    let lastTick = 0;
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    if (onProgress) {
      child.stdout.on('data', (d) => {
        const m = /out_time_ms=(\d+)/g.exec(d.toString());
        if (m && totalMs > 0) {
          const now = Date.now();
          if (now - lastTick > 500) {
            lastTick = now;
            onProgress(Math.min(1, Number(m[1]) / totalMs));
          }
        }
      });
    }
    child.on('error', (e) => resolve({ ok: false, err: `${e.message}（ffmpeg 未安装或不在 PATH？）` }));
    child.on('close', (code) => resolve({ ok: code === 0, err: err.trim() }));
  });
}

/** drawtext 文本转义（滤镜参数内的 : ' \ 需转义；文本用单引号包裹由调用方负责） */
function escDrawtext(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

/** 把字体复制到工作目录用相对路径引用（规避 Windows 盘符冒号与滤镜转义冲突） */
function stageFont(tmpDir) {
  const src = findFont();
  if (!src) return null;
  try {
    const dest = path.join(tmpDir, 'font' + path.extname(src));
    fs.copyFileSync(src, dest);
    return { rel: 'font' + path.extname(src), cjk: !/DejaVu/i.test(src) };
  } catch {
    return null;
  }
}

/** 收集项目的可渲染素材：每个镜头最新完成视频（本地优先）+ 最新成功旁白 */
function collectSegments(projectId) {
  const p = projects.get(projectId);
  if (!p) return null;
  const shots = projects.shots(projectId);
  const tasks = projects.tasks(projectId);
  const tts = projects.tts(projectId);
  const segments = [];
  for (const shot of shots) {
    const done = tasks
      .filter((t) => t.shot_id === shot.id && t.status === 'completed' && (t.video_local_path || t.metadata_url))
      .sort((a, b) => b.id - a.id)[0];
    if (!done) continue;
    const narr = tts
      .filter((x) => x.kind === 'shot' && x.shot_id === shot.id && x.local_path && !x.error_message)
      .sort((a, b) => b.id - a.id)[0];
    segments.push({
      shot,
      src: done.video_local_path || done.metadata_url,
      narrationPath: narr ? narr.local_path : null,
      narrationDuration: narr ? narr.duration : null,
      nominalSeconds: Number(shot.seconds || p.seconds || 5) || 5,
    });
  }
  return { project: p, segments, sceneImage: projects.selectedImage(projectId, 'scene') };
}

class Renderer {
  constructor() {
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) => log('error', `渲染循环异常: ${e.message}`)), TICK_MS);
    this.timer.unref?.();
    log('info', `渲染器已启动（ffmpeg ${hasFfmpeg() ? '可用' : '不可用，渲染请求将被拒绝'}）`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    if (this.busy || !hasFfmpeg()) return;
    const job = renders.queued()[0];
    if (!job) return;
    this.busy = true;
    try {
      await this.renderJob(job);
    } catch (e) {
      renders.update(job.id, { status: 'failed', error_message: `渲染异常：${e.message}` });
      log('error', `渲染任务 #${job.id} 异常：${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  fail(jobId, message) {
    renders.update(jobId, { status: 'failed', error_message: String(message).slice(0, 800) });
    log('error', `渲染任务 #${jobId} 失败：${message}`);
  }

  async renderJob(job) {
    renders.update(job.id, { status: 'rendering', progress: 1 });
    const collected = collectSegments(job.project_id);
    if (!collected) return this.fail(job.id, '项目不存在');
    const { project, segments, sceneImage } = collected;
    if (segments.length < 2) {
      return this.fail(job.id, `至少需要 2 个已完成视频的镜头才能渲染成片（当前 ${segments.length} 个）`);
    }
    const params = job.params || {};
    const fade = Math.min(Math.max((Number(params.transition_ms) || 600) / 1000, 0.2), 1.5);
    const narrOffset = Math.min(Math.max((Number(params.narration_offset_ms) || 500) / 1000, 0), 3);
    const wantTitle = params.title_card !== false;
    const wantEnd = params.end_card !== false;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-render-'));
    try {
      /* ---- 1) 归一化各镜头段（0-40%） ---- */
      const norm = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const dest = path.join(tmpDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`);
        const r = await runFfmpeg(['-i', seg.src, '-vf',
          `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${OUT_FPS},format=yuv420p`,
          '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', dest]);
        if (!r.ok) return this.fail(job.id, `镜头 ${seg.shot.seq} 归一化失败：${r.err.slice(0, 300)}`);
        const dur = probeDuration(dest) || seg.nominalSeconds;
        norm.push({ file: dest, duration: dur, narrationPath: seg.narrationPath });
        renders.update(job.id, { progress: 2 + Math.round((38 * (i + 1)) / segments.length) });
      }

      /* ---- 2) 片头/片尾卡（可选） ---- */
      const font = stageFont(tmpDir);
      const cards = [];
      if (wantTitle) {
        const card = await this.makeTitleCard(tmpDir, font, project.name);
        if (card) cards.push({ kind: 'head', ...card });
      }
      if (wantEnd) {
        const card = await this.makeEndCard(tmpDir, font, project.name, sceneImage?.local_path || sceneImage?.remote_url || null);
        if (card) cards.push({ kind: 'tail', ...card });
      }

      /* ---- 3) 拼装时间线 ---- */
      const seqs = [];
      for (const c of cards) if (c.kind === 'head') seqs.push(c);
      seqs.push(...norm);
      for (const c of cards) if (c.kind === 'tail') seqs.push(c);

      const fadeCount = seqs.length - 1;
      const total = seqs.reduce((s, x) => s + x.duration, 0) - fade * fadeCount;

      /* ---- 4) 终混（40-95%） ---- */
      const inputs = [];
      for (const s of seqs) inputs.push('-i', s.file);
      const narrIdxStart = seqs.length;
      const narrationFiles = norm.map((s) => s.narrationPath).filter(Boolean);
      for (const n of narrationFiles) inputs.push('-i', n);
      if (!narrationFiles.length) inputs.push('-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo');

      const fl = [];
      let prev = '[0:v]';
      let cum = seqs[0].duration;
      for (let k = 1; k < seqs.length; k++) {
        const offset = (cum - fade).toFixed(3);
        const out = k === seqs.length - 1 ? '[vout]' : `[vx${k}]`;
        fl.push(`${prev}[${k}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
        prev = out;
        cum += seqs[k].duration - fade;
      }
      // 旁白时间轴：镜头起幅点 = 片头卡后累计（每镜步进 = 本镜时长 - 叠化）
      const narrLabels = [];
      let ni = 0;
      let shotStart = cards.some((c) => c.kind === 'head') ? seqs[0].duration : 0;
      for (const s of norm) {
        if (s.narrationPath) {
          const startMs = Math.round((shotStart + narrOffset) * 1000);
          const label = `[n${ni}]`;
          fl.push(`[${narrIdxStart + ni}:a]adelay=${startMs}:all=1${label}`);
          narrLabels.push(label);
          ni += 1;
        }
        shotStart += s.duration - fade;
      }
      let aout;
      if (narrLabels.length) {
        fl.push(`${narrLabels.join('')}amix=inputs=${narrLabels.length}:duration=longest:normalize=0,alimiter=limit=0.92[aout]`);
        aout = '[aout]';
      } else {
        aout = `${narrIdxStart}:a`; // 静音源直接作为音轨（直接流映射不能带方括号标签）
      }

      const outName = `render-${job.id}-${Date.now()}.mp4`;
      const outPath = path.join(ARTIFACTS_DIR, outName);
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      const totalMs = total * 1000;
      const r = await runFfmpeg([
        ...inputs,
        '-filter_complex', fl.join(';'),
        '-map', '[vout]', '-map', aout,
        '-t', total.toFixed(2),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        outPath,
      ], {
        totalMs,
        onProgress: (pct) => renders.update(job.id, { progress: 40 + Math.round(55 * pct) }),
      });
      if (!r.ok) return this.fail(job.id, `终混失败：${r.err.slice(0, 400)}`);

      const outDur = probeDuration(outPath) || total;
      renders.update(job.id, { status: 'completed', progress: 100, output_path: outPath });
      log('info', `渲染任务 #${job.id} 完成：《${project.name}》 ${outDur.toFixed(1)}s / ${segments.length} 镜 → ${outPath}`);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** 片头卡：合成星野 + 居中片名（字体缺失/无中文字体时降级为纯星野） */
  async makeTitleCard(tmpDir, font, title) {
    const bg = path.join(tmpDir, 'title-bg.png');
    const r1 = await runFfmpeg([
      '-f', 'lavfi', '-i', `nullsrc=s=${OUT_W}x${OUT_H},geq=lum='if(lt(random(2),0.0025),170+random(0)*85,14)':cb=128:cr=128`,
      '-frames:v', '1', '-vf', 'gblur=sigma=0.35,vignette=PI/5,eq=saturation=0.3', bg,
    ]);
    if (!r1.ok) return { file: null, duration: TITLE_DUR, failed: r1.err };
    const dest = path.join(tmpDir, 'card-title.mp4');
    const vf = ['fade=t=in:st=0:d=0.9,fade=t=out:st=' + (TITLE_DUR - 0.6).toFixed(1) + ':d=0.6', 'format=yuv420p'];
    if (font && (font.cjk || !hasCJK(title))) {
      vf.unshift('drawtext=fontfile=' + font.rel + `:text='${escDrawtext(title)}':fontsize=72:fontcolor=0xF2ECDC:x=(w-text_w)/2:y=(h-text_h)/2`);
    }
    const r2 = await runFfmpeg([
      '-loop', '1', '-i', bg, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', String(TITLE_DUR), '-r', String(OUT_FPS), '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', dest,
    ], { cwd: tmpDir });
    if (!r2.ok) return { file: null, duration: TITLE_DUR, failed: r2.err };
    return { file: dest, duration: TITLE_DUR };
  }

  /** 片尾卡：场景图压暗 + 「— 完 —」与片名（无场景图/字体时降级） */
  async makeEndCard(tmpDir, font, title, sceneSrc) {
    const dest = path.join(tmpDir, 'card-end.mp4');
    const vf = [
      'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1',
      'eq=brightness=-0.12:saturation=0.9',
    ];
    if (font && (font.cjk || !hasCJK(title))) {
      vf.push('drawtext=fontfile=' + font.rel + `:text='— 完 —':fontsize=54:fontcolor=0xF2ECDC:x=(w-text_w)/2:y=(h-text_h)/2-30`);
      vf.push('drawtext=fontfile=' + font.rel + `:text='${escDrawtext(title)}':fontsize=26:fontcolor=0xC9CFDB:x=(w-text_w)/2:y=h-120`);
    }
    vf.push(`fade=t=in:st=0:d=0.8,fade=t=out:st=${(END_DUR - 0.6).toFixed(1)}:d=0.6`, 'format=yuv420p');
    const inputArgs = sceneSrc
      ? ['-loop', '1', '-i', sceneSrc]
      : ['-f', 'lavfi', '-i', `color=c=0x060A14:s=${OUT_W}x${OUT_H}`];
    const r = await runFfmpeg([
      ...inputArgs, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', String(END_DUR), '-r', String(OUT_FPS), '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', dest,
    ], { cwd: tmpDir });
    if (!r.ok) return { file: null, duration: END_DUR, failed: r.err };
    return { file: dest, duration: END_DUR };
  }
}

module.exports = new Renderer();
module.exports.collectSegments = collectSegments;
module.exports.hasFfmpeg = hasFfmpeg;
