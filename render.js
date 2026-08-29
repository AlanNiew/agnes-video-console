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
const { projects, renders, instanceLockHeldByOther } = require('./db');
const { ARTIFACTS_DIR } = require('./artifacts');
const netmusic = require('./netmusic');
const { log } = require('./logger');

const TICK_MS = 1500;
const OUT_FPS = 30;
const TITLE_DUR = 2.8;
const END_DUR = 3.5;
// v1.8 支持的成片方向：16:9 横屏（B站/西瓜/视频号）与 9:16 竖屏（抖音/快手）
const DIMS = { '16:9': { w: 1280, h: 720 }, '9:16': { w: 720, h: 1280 } };

/** 解析成片方向：显式参数 > 项目画幅 > 默认横屏 */
function resolveDims(aspect, projectRatio) {
  const a = ['16:9', '9:16'].includes(String(aspect))
    ? String(aspect)
    : (String(projectRatio) === '9:16' ? '9:16' : '16:9');
  return { aspect: a, ...DIMS[a] };
}

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
    return { rel: 'font' + path.extname(src), cjk: !/DejaVu/i.test(src), family: fontFamilyName(src) };
  } catch {
    return null;
  }
}

/** 从字体文件路径推断字体族名（ASS Style 用） */
function fontFamilyName(srcPath) {
  const p = String(srcPath || '').toLowerCase();
  if (p.includes('msyh')) return 'Microsoft YaHei';
  if (p.includes('simhei')) return 'SimHei';
  if (p.includes('pingfang')) return 'PingFang SC';
  if (p.includes('noto')) return 'Noto Sans CJK SC';
  if (p.includes('wqy')) return 'WenQuanYi Micro Hei';
  return 'Arial';
}

/* ---------------- v1.6 字幕烧录（ASS） ---------------- */

/** 秒 → ASS 中心秒时间 H:MM:SS.cc */
function assTime(t) {
  const s = Math.max(0, Number(t) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(text) {
  return String(text || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

/**
 * 生成 ASS 字幕文件内容（纯函数，供渲染与 e2e 断言）
 * @param {{start:number,end:number,text:string}[]} lines 时间轴（秒）
 * @param {{fontsize?:number, family?:string, playResX?:number, playResY?:number, marginV?:number}} [opts]
 */
function buildSubtitleAss(lines, { fontsize = 42, family = 'Microsoft YaHei', playResX = 1280, playResY = 720, marginV = 52 } = {}) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Narr,${family},${fontsize},&H00DCECF2,&H000000FF,&H00181410,&H80000000,1,0,0,0,100,100,0,0,1,2.2,1.2,2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const events = (lines || [])
    .filter((l) => l && l.text && l.end > l.start)
    .map((l) => `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Narr,,0,0,0,,{\\fad(150,150)}${assEscape(l.text)}`);
  return header + '\n' + events.join('\n') + (events.length ? '\n' : '');
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
    const dones = tasks
      .filter((t) => t.shot_id === shot.id && t.status === 'completed' && (t.video_local_path || t.metadata_url))
      .sort((a, b) => b.id - a.id);
    // v1.7 重拍定稿：镜头已选定 take 则优先用之，否则回退最新完成条
    const done = dones.find((t) => t.id === shot.take_task_id) || dones[0];
    if (!done) continue;
    const narr = tts
      .filter((x) => x.kind === 'shot' && x.shot_id === shot.id && x.local_path && !x.error_message)
      .sort((a, b) => b.id - a.id)[0];
    segments.push({
      shot,
      src: done.video_local_path || done.metadata_url,
      narrationPath: narr ? narr.local_path : null,
      narrationDuration: narr ? narr.duration : null,
      narrationText: narr ? narr.text : null, // v1.6：字幕烧录用旁白原文
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
    if (instanceLockHeldByOther()) return; // v1.6.1 工作锁
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
    // v1.4 BGM：音量 0–1（默认 0.35）；有旁白时可选闪避（sidechaincompress）
    const bgmVolume = Math.min(Math.max(Number(params.bgm_volume) || 0.35, 0), 1);
    const bgmDuck = params.bgm_duck !== false;
    // v1.5 旁白增益：TTS 原始电平偏保守，默认提升 1.4 倍让人声稳坐音乐之上
    const narrVolume = Math.min(Math.max(Number(params.narration_volume) || 1.4, 0.5), 3);
    // v1.6 字幕烧录：默认开启（有旁白文案时生效），字号 24–72
    const wantSubs = params.burn_subtitles !== false;
    const subFontsize = Math.min(Math.max(Number(params.subtitle_fontsize) || 42, 24), 72);
    // v1.8 成片方向：16:9 横屏 / 9:16 竖屏（默认跟随项目画幅）
    const dims = resolveDims(params.aspect, collected.project.aspect_ratio);
    const { w: OUT_W, h: OUT_H } = dims;

    /* ---- 0) BGM：优先本地缓存，缺失则现取播放地址重新下载 ---- */
    let bgmFile = null;
    const bgmSel = collected.project.bgm;
    if (bgmSel?.song_id) {
      try {
        if (bgmSel.local_path && fs.existsSync(bgmSel.local_path)) {
          bgmFile = bgmSel.local_path;
        } else {
          const dl = await netmusic.downloadBGM(bgmSel.song_id, bgmSel.level);
          bgmFile = dl.local_path;
          projects.setBgm(collected.project.id, { ...bgmSel, local_path: dl.local_path, local_url: dl.local_url });
        }
        log('info', `渲染任务 #${job.id} 使用 BGM：《${bgmSel.name}》${bgmSel.artist ? ` - ${bgmSel.artist}` : ''}`);
      } catch (e) {
        log('warn', `渲染任务 #${job.id} BGM 不可用（${e.message}），将以无 BGM 渲染`);
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-render-'));
    try {
      /* ---- 1) 归一化各镜头段（0-40%） ---- */
      const norm = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const dest = path.join(tmpDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`);
        const r = await runFfmpeg(['-i', seg.src, '-vf',
          `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${OUT_FPS},format=yuv420p`,
          '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', dest]);        if (!r.ok) return this.fail(job.id, `镜头 ${seg.shot.seq} 归一化失败：${r.err.slice(0, 300)}`);
        const dur = probeDuration(dest) || seg.nominalSeconds;
        norm.push({ file: dest, duration: dur, narrationPath: seg.narrationPath, narrationText: seg.narrationText, narrationDuration: seg.narrationDuration });
        renders.update(job.id, { progress: 2 + Math.round((38 * (i + 1)) / segments.length) });
      }

      /* ---- 2) 片头/片尾卡（可选） ---- */
      const font = stageFont(tmpDir);
      const cards = [];
      if (wantTitle) {
        const card = await this.makeTitleCard(tmpDir, font, project.name, dims);
        if (card) cards.push({ kind: 'head', ...card });
      }
      if (wantEnd) {
        const card = await this.makeEndCard(tmpDir, font, project.name, sceneImage?.local_path || sceneImage?.remote_url || null, dims);
        if (card) cards.push({ kind: 'tail', ...card });
      }

      /* ---- 3) 拼装时间线 ---- */
      const seqs = [];
      for (const c of cards) if (c.kind === 'head') seqs.push(c);
      seqs.push(...norm);
      for (const c of cards) if (c.kind === 'tail') seqs.push(c);

      const fadeCount = seqs.length - 1;
      const total = seqs.reduce((s, x) => s + x.duration, 0) - fade * fadeCount;

      /* ---- 3.5) 字幕时间轴（v1.6）：旁白起点 → 配音结束，不越过镜头边界 ---- */
      let subLines = [];
      if (wantSubs) {
        let st = cards.some((c) => c.kind === 'head') ? seqs[0].duration : 0;
        for (const s of norm) {
          if (s.narrationText) {
            const start = st + narrOffset;
            const end = Math.min(
              start + (Number(s.narrationDuration) || 4),
              st + s.duration - fade * 0.4
            );
            if (end > start + 0.2) subLines.push({ start, end, text: s.narrationText });
          }
          st += s.duration - fade;
        }
      }

      /* ---- 4) 终混（40-95%） ---- */
      const inputs = [];
      for (const s of seqs) inputs.push('-i', s.file);
      const narrIdxStart = seqs.length;
      const narrationFiles = norm.map((s) => s.narrationPath).filter(Boolean);
      for (const n of narrationFiles) inputs.push('-i', n);
      let silentIdx = -1;
      if (!narrationFiles.length) {
        silentIdx = narrIdxStart;
        inputs.push('-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo');
      }
      let bgmIdx = -1;
      if (bgmFile) {
        bgmIdx = narrIdxStart + narrationFiles.length + (silentIdx >= 0 ? 1 : 0);
        inputs.push('-stream_loop', '-1', '-i', bgmFile); // BGM 不足片长则循环
      }

      const fl = [];
      // v1.6：烧录字幕时 xfade 链先输出 [vpre]，再挂 subtitles 滤镜得 [vout]
      const needSubFilter = subLines.length > 0;
      log('info', `渲染任务 #${job.id} 字幕诊断：subLines=${subLines.length} needSubFilter=${needSubFilter} burn_subtitles=${wantSubs} narrText样本=${JSON.stringify((norm.find((s) => s.narrationText) || {}).narrationText || null).slice(0, 40)}`);
      if (needSubFilter) {
        const marginV = Math.round(OUT_H * (dims.aspect === '9:16' ? 0.15 : 0.072)); // 竖屏避开手机底部 UI 区
        fs.writeFileSync(path.join(tmpDir, 'subs.ass'), buildSubtitleAss(subLines, { fontsize: subFontsize, family: font?.family || 'Arial', playResX: OUT_W, playResY: OUT_H, marginV }));
      }
      let prev = '[0:v]';
      let cum = seqs[0].duration;
      for (let k = 1; k < seqs.length; k++) {
        const offset = (cum - fade).toFixed(3);
        const out = k === seqs.length - 1 ? (needSubFilter ? '[vpre]' : '[vout]') : `[vx${k}]`;
        fl.push(`${prev}[${k}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
        prev = out;
        cum += seqs[k].duration - fade;
      }
      if (needSubFilter) fl.push('[vpre]subtitles=subs.ass[vout]');
      // 旁白时间轴：镜头起幅点 = 片头卡后累计（每镜步进 = 本镜时长 - 叠化）
      // v1.5 旁白链（专业口播处理）：90Hz 高通去低频浊音 → 轻压缩平衡句间动态
      //   → 增益（默认 1.4×）→ 按镜头起幅点延迟对齐
      const narrLabels = [];
      let ni = 0;
      let shotStart = cards.some((c) => c.kind === 'head') ? seqs[0].duration : 0;
      for (const s of norm) {
        if (s.narrationPath) {
          const startMs = Math.round((shotStart + narrOffset) * 1000);
          const label = `[n${ni}]`;
          fl.push(
            `[${narrIdxStart + ni}:a]highpass=f=90,` +
            `acompressor=threshold=0.22:ratio=3:attack=8:release=220:makeup=1.15,` +
            `volume=${narrVolume},adelay=${startMs}:all=1${label}`
          );
          narrLabels.push(label);
          ni += 1;
        }
        shotStart += s.duration - fade;
      }
      // 终局响度标准化（EBU R128 单遍）：对齐流媒体响度目标，成片之间音量一致
      const loudnessChain = 'loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95';
      let aout;
      // v1.4 BGM 铺底链：循环源裁到片长 + 音量 + 首尾淡入淡出；有旁白可选闪避
      const bgmChain = (vol, label = '[bgm]') =>
        `[${bgmIdx}:a]atrim=0:${total.toFixed(2)},volume=${vol},` +
        `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, total - 3).toFixed(2)}:d=3${label}`;
      if (narrLabels.length) {
        fl.push(`${narrLabels.join('')}amix=inputs=${narrLabels.length}:duration=longest:normalize=0[narmix]`);
        if (bgmIdx >= 0) {
          fl.push(bgmChain(bgmVolume));
          // v1.5 闪避调优：阈值贴旁白电平、中等比率、快攻慢放——说话时音乐让路、句间自然回升
          fl.push('[narmix]asplit=2[narMain][narSc]');
          fl.push('[bgm][narSc]sidechaincompress=threshold=0.035:ratio=9:attack=40:release=450[bgmD]');
          fl.push(`[narMain][bgmD]amix=inputs=2:duration=longest:normalize=0,${loudnessChain}[aout]`);
        } else {
          fl.push(`[narmix]${loudnessChain}[aout]`);
        }
        aout = '[aout]';
      } else if (bgmIdx >= 0) {
        // 无旁白：BGM 适当抬升音量（保证成片有可听的音乐底）
        fl.push(bgmChain(Math.max(bgmVolume, 0.55), '[aout]'));
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
        cwd: tmpDir, // subtitles=subs.ass 相对路径 + libass 字体目录
        onProgress: (pct) => renders.update(job.id, { progress: 40 + Math.round(55 * pct) }),
      });
      if (!r.ok) return this.fail(job.id, `终混失败：${r.err.slice(0, 400)}`);

      const outDur = probeDuration(outPath) || total;

      /* ---- 5) 封面候选（v1.8：3 张关键帧，第一张叠片名；best-effort 不影响成片） ---- */
      const covers = [];
      try {
        const pickTimes = [0.18, 0.5, 0.82].map((r) => Math.min(Math.max(total * r, 0.5), Math.max(total - 0.4, 0.5)));
        for (let i = 0; i < pickTimes.length; i++) {
          const name = `cover-${job.id}-${i + 1}.png`;
          const cpath = path.join(ARTIFACTS_DIR, name);
          const args = ['-i', outPath, '-ss', pickTimes[i].toFixed(2), '-frames:v', '1'];
          if (i === 0 && font) {
            args.push('-vf', `drawtext=fontfile=${font.rel}:text='${escDrawtext(project.name)}':fontsize=${Math.round(dims.w * 0.052)}:fontcolor=0xF2ECDC:borderw=3:bordercolor=0x181410:x=(w-text_w)/2:y=h-text_h-${Math.round(dims.h * 0.06)}`);
          }
          args.push(cpath);
          const r = await runFfmpeg(args, { cwd: tmpDir });
          if (r.ok && fs.existsSync(cpath)) covers.push({ path: cpath, url: `/artifacts/${name}` });
        }
        if (covers.length) log('info', `渲染任务 #${job.id} 生成封面候选 ${covers.length} 张`);
      } catch (e) {
        log('warn', `渲染任务 #${job.id} 封面生成失败（不影响成片）：${e.message}`);
      }

      renders.update(job.id, { status: 'completed', progress: 100, output_path: outPath, covers });
      log('info', `渲染任务 #${job.id} 完成：《${project.name}》 ${outDur.toFixed(1)}s / ${segments.length} 镜 → ${outPath}`);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** 片头卡：合成星野 + 居中片名（字体缺失/无中文字体时降级为纯星野） */
  async makeTitleCard(tmpDir, font, title, dims = { w: 1280, h: 720 }) {
    const bg = path.join(tmpDir, 'title-bg.png');
    const r1 = await runFfmpeg([
      '-f', 'lavfi', '-i', `nullsrc=s=${dims.w}x${dims.h},geq=lum='if(lt(random(2),0.0025),170+random(0)*85,14)':cb=128:cr=128`,
      '-frames:v', '1', '-vf', 'gblur=sigma=0.35,vignette=PI/5,eq=saturation=0.3', bg,
    ]);
    if (!r1.ok) return { file: null, duration: TITLE_DUR, failed: r1.err };
    const dest = path.join(tmpDir, 'card-title.mp4');
    const vf = ['fade=t=in:st=0:d=0.9,fade=t=out:st=' + (TITLE_DUR - 0.6).toFixed(1) + ':d=0.6', 'format=yuv420p'];
    if (font && (font.cjk || !hasCJK(title))) {
      vf.unshift('drawtext=fontfile=' + font.rel + `:text='${escDrawtext(title)}':fontsize=${Math.round(dims.w * 0.1)}:fontcolor=0xF2ECDC:x=(w-text_w)/2:y=(h-text_h)/2`);
    }
    const r2 = await runFfmpeg([
      '-loop', '1', '-i', bg, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', String(TITLE_DUR), '-r', String(OUT_FPS), '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', dest,
    ], { cwd: tmpDir });
    if (!r2.ok) return { file: null, duration: TITLE_DUR, failed: r2.err };
    return { file: dest, duration: TITLE_DUR };
  }

  /** 片尾卡：场景图压暗 + 「— 完 —」与片名（无场景图/字体时降级） */
  async makeEndCard(tmpDir, font, title, sceneSrc, dims = { w: 1280, h: 720 }) {
    const dest = path.join(tmpDir, 'card-end.mp4');
    const vf = [
      `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},setsar=1`,
      'eq=brightness=-0.12:saturation=0.9',
    ];
    if (font && (font.cjk || !hasCJK(title))) {
      vf.push('drawtext=fontfile=' + font.rel + `:text='— 完 —':fontsize=54:fontcolor=0xF2ECDC:x=(w-text_w)/2:y=(h-text_h)/2-30`);
      vf.push('drawtext=fontfile=' + font.rel + `:text='${escDrawtext(title)}':fontsize=26:fontcolor=0xC9CFDB:x=(w-text_w)/2:y=h-120`);
    }
    vf.push(`fade=t=in:st=0:d=0.8,fade=t=out:st=${(END_DUR - 0.6).toFixed(1)}:d=0.6`, 'format=yuv420p');
    const inputArgs = sceneSrc
      ? ['-loop', '1', '-i', sceneSrc]
      : ['-f', 'lavfi', '-i', `color=c=0x060A14:s=${dims.w}x${dims.h}`];
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
module.exports.buildSubtitleAss = buildSubtitleAss;
