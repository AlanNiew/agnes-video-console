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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projects, renders, settings } = require('../db');
const { instanceLockHeldByOther } = require('../instance-lock');
const { ARTIFACTS_DIR, workDirFor } = require('../lib/artifacts');
const { createNetmusicClient } = require('../clients/netmusic');
const netmusic = createNetmusicClient(settings);
const { log } = require('../core/logger');
const { probeDuration } = require('../core/config');
const { RENDER_TRANSITIONS, SUBTITLE_STYLES, SUBTITLE_POSITIONS } = require('../core/constants');
const { buildSubtitleAss, buildSrt } = require('../services/subtitles');
const { buildPublishKit, findPublishMeta } = require('../lib/publish-kit');
const { PLATFORMS, buildPlatformCopy, renderCopyText, buildPackageReadme } = require('../lib/publish-package');

const TICK_MS = 1500;
// 单次 ffmpeg 调用的硬超时兜底：正常最慢的大合流约 3-6 分钟，20 分钟足够；
// 没有它时一旦输入不可达（远端 URL 弱网阻塞/磁盘写满），渲染会永久停在 rendering（v2.5 实测卡在 40%）
const FFMPEG_TIMEOUT_MS = 20 * 60 * 1000;
const OUT_FPS = 30;
const TITLE_DUR = 3.8;
const END_DUR = 3.5;
// v1.8 支持的成片方向：16:9 横屏（B站/西瓜/视频号）与 9:16 竖屏（抖音/快手）
const DIMS = { '16:9': { w: 1280, h: 720 }, '9:16': { w: 720, h: 1280 } };

/** 解析成片方向：显式参数 > 项目画幅 > 默认横屏 */
function resolveDims(aspect, projectRatio) {
  const a = ['16:9', '9:16'].includes(String(aspect))
    ? String(aspect)
    : String(projectRatio) === '9:16'
      ? '9:16'
      : '16:9';
  return { aspect: a, ...DIMS[a] };
}

/** 简易中文字符检测（用于字体能力降级） */
function hasCJK(s) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(String(s || ''));
}

/** v2.4 项目名 → 片头卡主/副标题：以首个空格拆分（如「幻灯屋 S1E01 灯を点す」→ 主「幻灯屋」/ 副「S1E01 灯を点す」） */
function splitCardTitle(name) {
  const s = String(name || '').trim();
  const i = s.indexOf(' ');
  if (i > 0) return { title: s.slice(0, i), subtitle: s.slice(i + 1).trim() };
  return { title: s, subtitle: '' };
}

/** 标题用衬线体（明朝/宋体）——片名主标题的"电影海报"质感；找不到则由主字体降级。
 *  注意：细明体（mingliub.ttc）缺简体与假名字形，会渲染成方块，故排除。 */
function findSerifFont() {
  const candidates = [
    'C:/Windows/Fonts/STSONG.TTF', // 华文宋体
    'C:/Windows/Fonts/simsun.ttc', // 宋体
    'C:/Windows/Fonts/NotoSerifSC-VF.ttf',
    '/System/Library/Fonts/Songti.ttc',
    '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return f;
    } catch {
      /* ignore */
    }
  }
  return null;
}

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
    try {
      if (fs.existsSync(f)) return f;
    } catch {
      /* ignore */
    }
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

// probeDuration 统一由 config.js 提供（消除与 server 侧的双实现漂移）

/** promisified ffmpeg 运行（可选 -progress 回调，onProgressPct(0-1)；timeoutMs 硬超时兜底） */
function runFfmpeg(args, { onProgress = null, totalMs = 0, cwd = undefined, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // -y：输出已存在时直接覆盖；-nostdin：断绝一切 stdin 交互。
    // 缺失时若产物同名文件已存在（如 jobId 复用的封面文件），ffmpeg 会打印
    // "Overwrite? [y/N]" 并阻塞等待管道 stdin 应答——父进程永不写入 → 渲染永久卡死。
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin', '-y', ...args], {
      windowsHide: true,
      cwd,
    });
    let err = '';
    let lastTick = 0;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略：进程可能已退出 */
      }
      finish({
        ok: false,
        err: `ffmpeg 超时（>${Math.round(timeoutMs / 1000)}s）已强制终止——通常是输入素材网络不可达或磁盘写入阻塞`,
      });
    }, timeoutMs);
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
    child.on('error', (e) => finish({ ok: false, err: `${e.message}（ffmpeg 未安装或不在 PATH？）` }));
    child.on('close', (code) => finish({ ok: code === 0, err: err.trim() }));
  });
}

/** 远端图片落地到工作目录（默认 180s 超时 + 1 次重试；cdn 实测 6MB 图在弱网下要 2 分钟）。
 * 为何必须本地化：把 http URL 直接喂给 ffmpeg（尤其配 -loop 1）会灾难性放大——
 * 卡片需要 3.8s×30fps≈114 帧，每帧都重新下载一次整图 → 渲染进度永久冻结（v2.5 实测卡在 40% 30 分钟）。 */
async function materializeImage(src, tmpDir, baseName, timeoutMs = 180000) {
  const ext = (path.extname(String(src).split('?')[0]).toLowerCase() || '.png').slice(0, 6);
  const dest = path.join(tmpDir, baseName + ext);
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('下载失败');
}

/** 卡片背景素材解析：本地文件在则直接用，否则先下载远端；都失败返回 null（退化为程序生成背景） */
async function resolveCardScene(sceneImage, tmpDir, jobId) {
  const local = sceneImage?.local_path;
  if (local && fs.existsSync(local)) return local;
  if (!sceneImage?.remote_url) return null;
  try {
    return await materializeImage(sceneImage.remote_url, tmpDir, 'card-scene');
  } catch (e) {
    log('warn', `渲染任务 #${jobId} 片头/片尾卡背景图不可用（${e.message}），改用程序生成背景`);
    return null;
  }
}

/* ---------- v2.5.1 归一化缓存：重渲时未变动的镜头段直接复用 ---------- */
const NORM_CACHE_DIR = path.join(ARTIFACTS_DIR, 'normcache');
const NORM_CACHE_TTL_MS = 12 * 24 * 3600 * 1000; // 12 天未使用即清理

/** 缓存键：源文件身份（本地=mtime+size，远端=URL）+ 目标规格 + 配方版本；任一变化即失效 */
function normCachePath(src, dims) {
  try {
    const s = String(src || '');
    if (!s) return null;
    let id = s;
    if (!/^https?:\/\//i.test(s)) {
      const st = fs.statSync(s);
      id = `${s}|${st.size}|${Math.round(st.mtimeMs)}`;
    }
    const h = crypto.createHash('sha1').update(`${id}|${dims.w}x${dims.h}|${OUT_FPS}|v1`).digest('hex').slice(0, 16);
    return path.join(NORM_CACHE_DIR, `${h}.mp4`);
  } catch {
    return null; // 源文件不存在（远端链接已过期等）→ 不缓存，走正常路径
  }
}

/** 清理过期归一化缓存（尽力而为，失败忽略） */
function pruneNormCache() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(NORM_CACHE_DIR)) {
      const p = path.join(NORM_CACHE_DIR, f);
      if (now - fs.statSync(p).mtimeMs > NORM_CACHE_TTL_MS) fs.rmSync(p, { force: true });
    }
  } catch {
    /* 目录不存在或不可读 */
  }
}

/** drawtext 文本转义（滤镜参数内的 : ' \ % 需转义；文本用单引号包裹由调用方负责）。
 * % 必须转义：drawtext 默认 expansion=normal，%{expr} 会被 ffmpeg 表达式引擎求值
 * （无命令执行能力，但会导致渲染失败或封面显示非预期计算值）。 */
function escDrawtext(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

/** 把字体复制到工作目录用相对路径引用（规避 Windows 盘符冒号与滤镜转义冲突） */
function stageFont(tmpDir) {
  const src = findFont();
  if (!src) return null;
  try {
    const ext = path.extname(src);
    const rel = 'font' + ext;
    fs.copyFileSync(src, path.join(tmpDir, rel));
    // v2.5.4：主标题用的衬线体（明朝/宋体）；缺失时回落到主字体
    let titleRel = rel;
    const serif = findSerifFont();
    if (serif) {
      try {
        titleRel = 'font-title' + path.extname(serif);
        fs.copyFileSync(serif, path.join(tmpDir, titleRel));
      } catch {
        titleRel = rel;
      }
    }
    return { rel, cjk: !/DejaVu/i.test(src), family: fontFamilyName(src), titleRel };
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

/** 字距展开（字符间插空格，营造排版感；渲染端与预览端共用） */
function spaced(s) {
  return String(s || '')
    .split('')
    .filter((c) => c.trim())
    .join(' ');
}

/** 集号与集名拆解：「S1E04 雨の音」→ { epNo:'S1E04', epTitle:'雨の音' }（无集号则整串作集名） */
function splitEpisodeLabel(label) {
  const s = String(label || '').trim();
  const m = /^(S\d+E\d+|第[0-9一二三四五六七八九十百]+[话集回])\s*(.*)$/i.exec(s);
  if (!m) return { epNo: '', epTitle: s };
  return { epNo: m[1], epTitle: m[2] };
}

/**
 * 片头卡滤镜链（v2.5.4 视觉重设计）——纯函数，供渲染与 `tools/card-preview.js` 共用：
 *   左上系列标识（宽字距）+ 细分隔线 + 集号 → 居中**纵向**主标题（明朝/宋体）→ 底部署名 + 细分隔线
 *   外加细内框（装裱感）。纵向主标题逐字绘制并各自居中：比 `\n` 方案可控，也不怕滤镜串换行。
 * @param {{dims:{w:number,h:number}, font:{rel:string,titleRel?:string}, texts:{title?:string,subtitle?:string,creator?:string}}} o
 * @returns {string[]} ffmpeg -vf 片段数组（顺序即层叠顺序）
 */
function titleCardFilters({ dims, font, texts = {}, style = {} }) {
  const { title = '', subtitle = '', creator = '' } = texts;
  // v2.5.4 定稿风格：挂轴纸带（浅底深字，缩略图下对比最强）。style 仅供 tools/card-preview.js 试版。
  const band = style.band !== false;
  const heroSans = style.hero === 'sans';
  const fakeBold = style.fakeBold === true;
  const w = dims.w;
  const h = dims.h;
  const vf = [];
  const canText = font && (font.cjk || !hasCJK(`${title}${subtitle}${creator}`));
  if (!canText) return vf;

  const sans = font.rel;
  const serif = font.titleRel || font.rel;
  const heroFont = heroSans ? sans : serif;
  const { epNo, epTitle } = splitEpisodeLabel(subtitle);

  // 细内框（照片装裱感）
  vf.push(
    `drawbox=x=${Math.round(w * 0.033)}:y=${Math.round(h * 0.046)}` +
      `:w=${Math.round(w * 0.934)}:h=${Math.round(h * 0.908)}:color=0xF3EAD8@0.18:t=2`,
  );

  // 左上：系列标识（宽字距）+ 细分隔线 + 集号
  const markSize = Math.round(w * 0.043);
  const markX = Math.round(w * 0.072);
  const markY = Math.round(h * 0.108);
  if (title) {
    vf.push(
      `drawtext=fontfile=${sans}:text='${escDrawtext(spaced(title))}':fontsize=${markSize}` +
        `:fontcolor=0xF7F1E4:borderw=2:bordercolor=0x14100C@0.85:x=${markX}:y=${markY}`,
    );
  }
  const ruleY = markY + Math.round(w * 0.062);
  vf.push(
    `drawbox=x=${markX}:y=${ruleY}:w=${Math.round(w * 0.082)}:h=${Math.max(2, Math.round(w * 0.0016))}` +
      `:color=0xF5EFE2@0.5:t=fill`,
  );
  if (epNo) {
    vf.push(
      `drawtext=fontfile=${sans}:text='${escDrawtext(spaced(epNo))}':fontsize=${Math.round(w * 0.0225)}` +
        `:fontcolor=0xE4DAC6:borderw=2:bordercolor=0x14100C@0.85` +
        `:x=${markX + 2}:y=${ruleY + Math.round(w * 0.012)}`,
    );
  }

  // 主标题：纵向逐字（自动缩放以适配过长的集名）
  const chars = String(epTitle || title || '')
    .replace(/\s+/g, '')
    .split('');
  if (chars.length) {
    const fit = Math.floor((h * 0.58) / (chars.length * 1.16));
    const size = Math.max(
      Math.round(w * 0.05),
      Math.min(heroSans ? Math.round(w * 0.125) : Math.round(w * 0.108), fit),
    );
    const step = Math.round(size * 1.16);
    const blockH = step * chars.length - (step - size);
    // 整块略高于画面中心（海报常见构图），纸带与文字用同一位移以保证"字在纸带内居中"
    const blockTop = Math.round((h - blockH) / 2 - h * 0.075);
    const top = blockTop;
    if (band) {
      // 纵向纸带（挂轴）：浅底 + 细边 + 上下木色"轴"杆，把纵排标题衬成"一幅字"
      const bw = Math.round(w * 0.2);
      const by = blockTop - Math.round(h * 0.075);
      const bh = Math.round(blockH + h * 0.15);
      const bx = Math.round((w - bw) / 2);
      vf.push(`drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=0xEFE6D2@0.90:t=fill`);
      vf.push(
        `drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=0x6b6152@0.55:` + `t=${Math.max(2, Math.round(w * 0.0016))}`,
      );
      // 轴杆（比纸带略宽，木色）
      const barH = Math.max(4, Math.round(h * 0.013));
      const barX = bx - Math.round(w * 0.008);
      const barW = bw + Math.round(w * 0.016);
      vf.push(`drawbox=x=${barX}:y=${by - barH}:w=${barW}:h=${barH}:color=0x7d5c3a@0.95:t=fill`);
      vf.push(`drawbox=x=${barX}:y=${by + bh}:w=${barW}:h=${barH}:color=0x7d5c3a@0.95:t=fill`);
    }
    const inkColor = band ? '0x241d16' : '0xF8F2E6';
    const offsets =
      fakeBold && !band
        ? [
            [0, 0],
            [Math.round(w * 0.0013), 0],
            [0, Math.round(w * 0.0017)],
          ]
        : [[0, 0]];
    chars.forEach((ch, i) => {
      for (const [dx, dy] of offsets) {
        vf.push(
          `drawtext=fontfile=${heroFont}:text='${escDrawtext(ch)}':fontsize=${size}` +
            `:fontcolor=${inkColor}:borderw=${band ? 0 : 3}:bordercolor=0x120F0B@0.85` +
            `:x=(w-text_w)/2+${dx}:y=${top + i * step + dy}`,
        );
      }
    });
  }

  // 底部：细分隔线 + 署名
  if (creator) {
    const cRuleY = Math.round(h * 0.845);
    vf.push(
      `drawbox=x=${Math.round(w * 0.425)}:y=${cRuleY}:w=${Math.round(w * 0.15)}` +
        `:h=${Math.max(2, Math.round(w * 0.0016))}:color=0xF5EFE2@0.36:t=fill`,
    );
    vf.push(
      `drawtext=fontfile=${sans}:text='${escDrawtext(spaced(creator))}':fontsize=${Math.round(w * 0.0195)}` +
        `:fontcolor=0xE0D6C4:x=(w-text_w)/2:y=${cRuleY + Math.round(h * 0.022)}`,
    );
  }
  return vf;
}

/** v2.5：制作档案自动草稿（参数 + 规格 + 镜头清单；「复盘与教训」留空待补）——沉淀为可复用资产 */
function buildArchiveDoc({ job, project, segments }) {
  const p = job.params || {};
  const q = job.quality || {};
  const row = (s) => {
    const refs =
      s.shot.use_character_ref === 0
        ? '纯空镜'
        : Array.isArray(s.shot.ref_image_ids) && s.shot.ref_image_ids.length
          ? s.shot.ref_image_ids.map((x) => '#' + x).join('/')
          : '全部定稿角色图';
    const narr = String(s.narrationText || '')
      .split('\n')[0]
      .slice(0, 40);
    return `| ${s.shot.seq} | ${s.shot.title || ''} | ${s.nominalSeconds}s | ${refs} | ${narr} |`;
  };
  return [
    `# 《${project.name}》制作档案（自动草稿 · 渲染 #${job.id}）`,
    '',
    '> 由渲染归档自动生成；「复盘与教训」留空待补。素材清单/一致性台账见同目录与 `docs/stories/`。',
    '',
    '## 规格',
    `- 镜数：${q.shots ?? segments.length} · 时长：${q.duration_s ?? '?'}s（偏差 ${q.duration_deviation_pct ?? '?'}%）· 响度：${q.loudness_lufs ?? '?'} LUFS`,
    `- 旁白覆盖：${q.narrated_shots ?? '?'}/${q.shots ?? '?'} 镜 · 字幕：${q.sub_lines ?? '?'} 行`,
    '',
    '## 渲染参数',
    '',
    '```json',
    JSON.stringify(p, null, 2),
    '```',
    '',
    '## 镜头清单',
    '',
    '| # | 标题 | 秒 | 角色引用 | 旁白 |',
    '| --- | --- | --- | --- | --- |',
    ...segments.map(row),
    '',
    '## 复盘与教训',
    '',
    '（待补：本集遇到的问题、判型结论、下次可复用要点）',
    '',
  ].join('\n');
}

/* ---------- v2.6 多平台发布包（阶段一）：本地物料生成，不涉及任何登录态与风控 ---------- */

/** 图片/视频尺寸（ffprobe；失败返回 null） */
function probeSize(file) {
  try {
    const r = spawnSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    const [w, h] = String(r.stdout || '')
      .trim()
      .split(',')
      .map((x) => Number(x));
    return w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}

/**
 * v2.6 画幅填充（模糊背景填充，保完整构图，**不裁切**）：
 *   底层 = 原画面放大铺满 + 高斯模糊；上层 = 原画面等比缩放居中（16:9 ↔ 9:16 互转共用）。
 * 视频分支优先 `-c:a copy` 流拷贝 → **时长/音量/响度与成片完全一致**（只做视频滤镜）；
 * 音轨非 mp4 兼容编码时降级重编码（响度不受影响，仅损失极少音质）。
 * @param {{src:string, dest:string, w:number, h:number, isVideo?:boolean, cwd?:string}} o
 */
async function fillAspect({ src, dest, w, h, isVideo = true, cwd = undefined }) {
  const sigma = Math.max(8, Math.round(Math.min(w, h) * 0.03));
  const vf =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
    `gblur=sigma=${sigma},setsar=1[bg];` +
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=${isVideo ? 'yuv420p' : 'rgb24'}[v]`;
  const common = [
    '-i',
    src,
    '-filter_complex',
    vf,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
  ];
  if (!isVideo) return runFfmpeg([...common, '-frames:v', '1', dest], { cwd });
  const first = await runFfmpeg([...common, '-map', '0:a?', '-c:a', 'copy', '-movflags', '+faststart', dest], {
    cwd,
  });
  if (first.ok) return first;
  return runFfmpeg([...common, '-map', '0:a?', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', dest], {
    cwd,
  });
}

/**
 * v2.6 生成多平台发布包（阶段一交付物）：
 *   作品目录/发布包/{B站,抖音}/ + README.md，平台文案来自 tools/publish/*.json（缺失自动降级）。
 * **幂等**：整包删除重建，重渲后再生成不堆积。
 * @param {{project:object, job:object, filmPath:string, coverPath?:string|null, workDir:string}} o
 * @returns {Promise<{dir:string, files:Array<{platform:string,name:string,path:string,role:string}>, notes:string[]}>}
 */
async function buildPublishPackage({ project, job, filmPath, coverPath = null, workDir }) {
  const pkgDir = path.join(workDir, '发布包');
  const notes = [];
  const meta = findPublishMeta(project) || {};
  const copy = buildPlatformCopy({ project, meta, job });
  const biliDir = path.join(pkgDir, PLATFORMS[0].dir);
  const dyDir = path.join(pkgDir, PLATFORMS[1].dir);
  const BILI = DIMS['16:9'];
  const DY = DIMS['9:16'];

  fs.rmSync(pkgDir, { recursive: true, force: true }); // 幂等：整包重建，不堆积旧文件
  fs.mkdirSync(biliDir, { recursive: true });
  fs.mkdirSync(dyDir, { recursive: true });

  // ---- B 站：成片直接可用（不重编码）----
  fs.copyFileSync(filmPath, path.join(biliDir, '成片.mp4'));
  // B 站封面：16:9（源封面画幅不合时用同款模糊填充，满足 ≥1146×717 的画幅要求）
  const biliCover = path.join(biliDir, '封面.png');
  if (coverPath && fs.existsSync(coverPath)) {
    const sz = probeSize(coverPath);
    if (sz && sz.w === BILI.w && sz.h === BILI.h) fs.copyFileSync(coverPath, biliCover);
    else {
      const r = await fillAspect({ src: coverPath, dest: biliCover, w: BILI.w, h: BILI.h, isVideo: false });
      if (!r.ok) notes.push(`B 站封面转 16:9 失败（原图已跳过）：${r.err.slice(0, 120)}`);
    }
  } else {
    notes.push('未找到封面.png（片头卡抽帧失败或未启用片头卡），B 站封面需自行补图。');
  }

  // ---- 抖音 / 快手：9:16 竖屏切片（画幅已一致则直接复制，零重编码）----
  const dyFilm = path.join(dyDir, '成片-竖屏.mp4');
  const filmSize = probeSize(filmPath);
  if (filmSize && filmSize.w === DY.w && filmSize.h === DY.h) {
    fs.copyFileSync(filmPath, dyFilm);
    notes.push('原成片即 9:16 竖屏，竖屏版本为直接复制（零重编码，音画与成片一致）。');
  } else {
    const r = await fillAspect({ src: filmPath, dest: dyFilm, w: DY.w, h: DY.h, isVideo: true });
    if (!r.ok) throw new Error(`竖屏切片失败：${r.err.slice(0, 160) || 'ffmpeg 未安装或不在 PATH'}`);
  }
  const dyCover = path.join(dyDir, '封面-竖屏.png');
  if (coverPath && fs.existsSync(coverPath)) {
    const sz = probeSize(coverPath);
    if (sz && sz.w === DY.w && sz.h === DY.h) fs.copyFileSync(coverPath, dyCover);
    else {
      const r = await fillAspect({ src: coverPath, dest: dyCover, w: DY.w, h: DY.h, isVideo: false });
      if (!r.ok) notes.push(`竖屏封面生成失败（原图已跳过）：${r.err.slice(0, 120)}`);
    }
  }

  // ---- 文案.txt（可直接全选复制到发布页）+ README（上传步骤与文件清单）----
  const files = [];
  for (const p of PLATFORMS) {
    const dir = path.join(pkgDir, p.dir);
    fs.writeFileSync(path.join(dir, '文案.txt'), `\ufeff${renderCopyText(p.key, copy[p.key], p.files)}`, 'utf8');
    for (const f of p.files) {
      const abs = path.join(dir, f.name);
      if (fs.existsSync(abs)) files.push({ platform: p.dir, name: f.name, path: abs, role: f.role });
    }
  }
  fs.writeFileSync(
    path.join(pkgDir, 'README.md'),
    `\ufeff${buildPackageReadme({ project, job, copy, notes })}`,
    'utf8',
  );
  return { dir: pkgDir, files, notes };
}

/** v2.2：作品归档——成片/字幕/台词写入 data/works/《项目名》-id/（与素材目录彻底分开）
 * 成片与字幕按渲染任务版本化（重渲追加），台词/海报为项目最新版覆盖。
 * v2.5：追加「制作档案-N.md」自动草稿。
 * v2.6：追加「发布包/」（B 站 16:9 + 抖音 9:16 竖屏）——失败不影响成片归档。
 * @returns {Promise<string|null>} 作品目录绝对路径（失败返回 null，不影响成片状态） */
async function archiveWork({ job, project, segments, subLines, outPath, titleCardFile = null }) {
  try {
    const { dir } = workDirFor(project);
    fs.mkdirSync(dir, { recursive: true });
    // 成片（版本化：同项目多次渲染共存）
    fs.copyFileSync(outPath, path.join(dir, `成片-${job.id}.mp4`));
    // SRT 字幕（时间轴与成片一致；无字幕行时也落空文件占位说明）
    const srt = subLines.length ? buildSrt(subLines) : '1\n00:00:00,000 --> 00:00:02,000\n（本片无旁白字幕）\n';
    fs.writeFileSync(path.join(dir, `字幕-${job.id}.srt`), `\ufeff${srt}`, 'utf8'); // BOM：Windows 记事本正确识别 UTF-8
    // 旁白台词（项目级最新版：镜头序号 + 标题 + 台词）
    const narrated = segments.filter((s) => s.narrationText);
    const scriptText = [
      `《${project.name}》旁白台词`,
      narrated.length ? '' : '（本片无旁白）',
      ...narrated.map((s) => `镜头${s.shot.seq}${s.shot.title ? `《${s.shot.title}》` : ''}：${s.narrationText}`),
    ].join('\n');
    fs.writeFileSync(path.join(dir, '旁白台词.txt'), `\ufeff${scriptText}\n`, 'utf8');
    // v2.5：制作档案自动草稿（沉淀为可复用资产；人工/AI 只需补复盘段）
    try {
      fs.writeFileSync(
        path.join(dir, `制作档案-${job.id}.md`),
        `\ufeff${buildArchiveDoc({ job, project, segments })}`,
        'utf8',
      );
    } catch {
      /* 档案生成失败不影响成片归档 */
    }
    // v2.5：发布文案（标题/简介/标签/置顶评论/看点时间轴）——一键复制到 B 站发布页
    try {
      fs.writeFileSync(
        path.join(dir, `发布文案-${job.id}.md`),
        `\ufeff${buildPublishKit({ project, job, srt, segments })}`,
        'utf8',
      );
    } catch {
      /* 发布文案生成失败不影响成片归档 */
    }
    // v2.5.3 交付封面：片头卡帧（主/副标题与署名已成图）——作品库缩略图与发布封面同源
    if (titleCardFile && fs.existsSync(titleCardFile)) {
      try {
        fs.copyFileSync(titleCardFile, path.join(dir, '封面.png'));
      } catch {
        /* 封面写入失败不影响成片归档 */
      }
    }
    // v2.6 多平台发布包（阶段一）：每集成片归档时自动生成 发布包/（B 站 16:9 + 抖音 9:16 竖屏）
    try {
      const r = await buildPublishPackage({
        project,
        job,
        filmPath: path.join(dir, `成片-${job.id}.mp4`),
        coverPath: path.join(dir, '封面.png'),
        workDir: dir,
      });
      if (r.notes.length) log('warn', `渲染任务 #${job.id} 发布包降级项：${r.notes.join('；')}`);
    } catch (e) {
      log('warn', `渲染任务 #${job.id} 发布包生成失败（不影响成片与其它归档）：${e.message}`);
    }
    return dir;
  } catch (e) {
    log('warn', `渲染任务 #${job.id} 作品归档失败（不影响成片）：${e.message}`);
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
    const dones = tasks
      .filter((t) => t.shot_id === shot.id && t.status === 'completed' && (t.video_local_path || t.metadata_url))
      .sort((a, b) => b.id - a.id);
    // v1.7 重拍定稿：镜头已选定 take 则优先用之，否则回退最新完成条
    const done = dones.find((t) => t.id === shot.take_task_id) || dones[0];
    if (!done) continue;
    const narr = tts
      .filter((x) => x.kind === 'shot' && x.shot_id === shot.id && x.local_path && !x.error_message)
      .sort((a, b) => b.id - a.id)[0];
    // 字幕文本：优先镜头旁白脚本（支持外语配音+本地语言字幕）；配音文本与脚本不同则双语两行（脚本在上、配音在下）
    const scriptText = shot.narration || (narr ? narr.text : null);
    const dubText = narr ? narr.text : null;
    const narrationText = dubText && scriptText && dubText !== scriptText ? `${scriptText}\n${dubText}` : scriptText;
    segments.push({
      shot,
      src: done.video_local_path || done.metadata_url,
      narrationPath: narr ? narr.local_path : null,
      narrationDuration: narr ? narr.duration : null,
      narrationText,
      narrationOffsetMs: narr ? narr.offset_ms || null : null, // v2.3 逐镜偏移（角色对白）：null=用全局 offset
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
    // v1.9.2 渲染自愈：进程崩溃/被杀时正在渲染的任务会永久卡在 rendering
    // （删除接口拒绝 rendering 状态，用户无解卡途径）——启动时复位回 queued 重新渲染。
    // 注：接管场景（原持有者心跳饿死被误判消亡）可能把活任务复位重复渲染，
    // 产物文件名带时间戳不冲突，代价仅为重复一次 ffmpeg，概率与代价均可接受。
    const stuck = renders.resetStuck();
    if (stuck > 0) log('warn', `发现 ${stuck} 个渲染中断的任务，已复位重新排队`);
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
    if (this.busy) return;
    if (instanceLockHeldByOther()) return; // v1.6.1 工作锁
    if (!hasFfmpeg()) {
      // v2.2.2：ffmpeg 中途不可用时不再静默空转——把排队任务标失败，用户能看到原因而不是永远 queued
      const stuck = renders.queued();
      if (stuck.length) {
        for (const j of stuck) this.fail(j.id, '未检测到 ffmpeg（需安装并加入 PATH），渲染任务无法执行');
        log('warn', `ffmpeg 不可用，已将 ${stuck.length} 个排队渲染任务标记为失败`);
      }
      return;
    }
    const job = renders.queued()[0];
    if (!job) return;
    this.busy = true;
    try {
      await this.renderJob(job);
    } catch (e) {
      log('error', `渲染任务 #${job.id} 异常: ${e.message}`);
      renders.update(job.id, { status: 'failed', error_message: '渲染异常：请查看「日志」面板获取详细信息后重试' });
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
    // v2.0 转场类型：xfade 白名单（非法值兜底 fade，旧任务参数无该字段也兜底）
    const transitionType = RENDER_TRANSITIONS.includes(params.transition_type) ? params.transition_type : 'fade';
    const narrOffset = Math.min(Math.max((Number(params.narration_offset_ms) || 500) / 1000, 0), 3);
    const wantTitle = params.title_card !== false;
    const wantEnd = params.end_card !== false;
    // v1.4 BGM：音量 0–1（默认 0.35）；有旁白时可选闪避（sidechaincompress）
    const bgmVolume = Math.min(Math.max(Number(params.bgm_volume) || 0.35, 0), 1);
    const bgmDuck = params.bgm_duck !== false;
    // v2.5 镜头原声（AI 生成的环境声）混入音量：0 = 剥离（默认），>0 低音量混入
    const ambVolume = Math.min(Math.max(Number(params.ambient_volume) || 0, 0), 1);
    // v1.5 旁白增益：TTS 原始电平偏保守，默认提升 1.4 倍让人声稳坐音乐之上
    const narrVolume = Math.min(Math.max(Number(params.narration_volume) || 1.4, 0.5), 3);
    // v1.6 字幕烧录：默认开启（有旁白文案时生效），字号 24–72；v2.0 样式与位置
    const wantSubs = params.burn_subtitles !== false;
    const subFontsize = Math.min(Math.max(Number(params.subtitle_fontsize) || 42, 24), 72);
    const subStyle = SUBTITLE_STYLES.includes(params.subtitle_style) ? params.subtitle_style : 'white-outline';
    const subPosition = SUBTITLE_POSITIONS.includes(params.subtitle_position) ? params.subtitle_position : 'bottom';
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
      pruneNormCache();
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const dest = path.join(tmpDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`);
        const cached = normCachePath(seg.src, { w: OUT_W, h: OUT_H });
        let file = dest;
        if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 0) {
          file = cached; // 命中缓存：跳过转码（重渲时省下未变动镜头的时间）
          log('info', `渲染任务 #${job.id} 镜头 ${seg.shot.seq} 复用归一化缓存`);
        } else {
          const r = await runFfmpeg([
            '-i',
            seg.src,
            // v2.5：保留镜头原声（AI 环境声）供低音量混入；无音轨的素材不报错
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-vf',
            `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${OUT_FPS},format=yuv420p`,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '18',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-ar',
            '44100',
            '-ac',
            '2',
            dest,
          ]);
          if (!r.ok) {
            // 详情页不给用户贴 ffmpeg 原文（看不懂也修不了），原文进日志供排查
            log('error', `渲染任务 #${job.id} 镜头 ${seg.shot.seq} 归一化失败（stderr）：${r.err.slice(0, 1200)}`);
            return this.fail(
              job.id,
              `镜头 ${seg.shot.seq} 的视频素材无法处理（可能已损坏或编码不被支持），请重拍该镜头后再渲染`,
            );
          }
          if (cached) {
            try {
              fs.mkdirSync(NORM_CACHE_DIR, { recursive: true });
              fs.copyFileSync(dest, cached);
            } catch {
              /* 缓存写入失败不影响本次渲染 */
            }
          }
        }
        const dur = probeDuration(file) || seg.nominalSeconds;
        norm.push({
          file,
          duration: dur,
          narrationPath: seg.narrationPath,
          narrationText: seg.narrationText,
          narrationDuration: seg.narrationDuration,
        });
        renders.update(job.id, { progress: 2 + Math.round((38 * (i + 1)) / segments.length) });
      }

      /* ---- 2) 片头/片尾卡（可选；v2.4 支持主题画面 + 主/副标题 + 署名） ---- */
      const font = stageFont(tmpDir);
      // 背景素材必须先落地成本地文件：远端 URL 直喂 ffmpeg（尤其 -loop 1）在弱网下会永久阻塞
      const cardScene = await resolveCardScene(sceneImage, tmpDir, job.id);
      const nameParts = splitCardTitle(project.name);
      const cardTitle = params.title || nameParts.title;
      const cardSub = params.subtitle !== undefined && params.subtitle !== null ? params.subtitle : nameParts.subtitle;
      const creator = params.creator || '';
      const cards = [];
      if (wantTitle) {
        const card = await this.makeTitleCard(
          tmpDir,
          font,
          { title: cardTitle, subtitle: cardSub, creator },
          cardScene,
          dims,
        );
        if (card) cards.push({ kind: 'head', ...card });
      }
      if (wantEnd) {
        const card = await this.makeEndCard(tmpDir, font, { title: cardTitle, creator }, cardScene, dims);
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
            // v2.3 逐镜偏移：对白镜 TTS 记录带 offset_ms → 用它；旁白镜 null → 全局 narrOffset
            const offMs = s.narrationOffsetMs != null ? s.narrationOffsetMs : narrOffset;
            const start = st + offMs;
            const end = Math.min(start + (Number(s.narrationDuration) || 4), st + s.duration - fade * 0.4);
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
        // v2.4.1：支持跳过音源开头（部分 BGM 文件开头有静音 padding 或爆音/咔哒，听感像"咯噔"）
        const bgmStartSec = Math.max(0, (Number(params.bgm_start_ms) || 0) / 1000);
        if (bgmStartSec > 0) inputs.push('-ss', bgmStartSec.toFixed(3));
        inputs.push('-stream_loop', '-1', '-i', bgmFile); // BGM 不足片长则循环
      }

      const fl = [];
      // v1.6：烧录字幕时 xfade 链先输出 [vpre]，再挂 subtitles 滤镜得 [vout]
      const needSubFilter = subLines.length > 0;
      log(
        'info',
        `渲染任务 #${job.id} 字幕诊断：subLines=${subLines.length} needSubFilter=${needSubFilter} burn_subtitles=${wantSubs} narrText样本=${JSON.stringify((norm.find((s) => s.narrationText) || {}).narrationText || null).slice(0, 40)}`,
      );
      if (needSubFilter) {
        const marginV = Math.round(OUT_H * (dims.aspect === '9:16' ? 0.15 : 0.072)); // 竖屏避开手机底部 UI 区
        fs.writeFileSync(
          path.join(tmpDir, 'subs.ass'),
          buildSubtitleAss(subLines, {
            fontsize: subFontsize,
            family: font?.family || 'Arial',
            playResX: OUT_W,
            playResY: OUT_H,
            marginV,
            style: subStyle,
            position: subPosition,
          }),
        );
      }
      let prev = '[0:v]';
      let cum = seqs[0].duration;
      for (let k = 1; k < seqs.length; k++) {
        const offset = (cum - fade).toFixed(3);
        const out = k === seqs.length - 1 ? (needSubFilter ? '[vpre]' : '[vout]') : `[vx${k}]`;
        fl.push(`${prev}[${k}:v]xfade=transition=${transitionType}:duration=${fade}:offset=${offset}${out}`);
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
          // v2.3 逐镜偏移：对白镜 TTS 记录带 offset_ms → 用它；旁白镜 null → 全局 narrOffset
          const offMs = s.narrationOffsetMs != null ? s.narrationOffsetMs : narrOffset;
          const startMs = Math.round((shotStart + offMs) * 1000);
          const label = `[n${ni}]`;
          fl.push(
            `[${narrIdxStart + ni}:a]highpass=f=90,` +
              `acompressor=threshold=0.22:ratio=3:attack=8:release=220:makeup=1.15,` +
              `volume=${narrVolume},adelay=${startMs}:all=1${label}`,
          );
          narrLabels.push(label);
          ni += 1;
        }
        shotStart += s.duration - fade;
      }
      // v2.5 镜头原声（AI 环境声）时间轴：同样按"镜头起幅点"对齐，低音量混入
      const ambLabels = [];
      if (ambVolume > 0) {
        let ambStart = cards.some((c) => c.kind === 'head') ? seqs[0].duration : 0;
        let ai = 0;
        for (const s of norm) {
          const segIdx = seqs.indexOf(s); // 段在 seqs / inputs 中的索引
          const label = `[amb${ai}]`;
          fl.push(
            `[${segIdx}:a]highpass=f=60,volume=${ambVolume},` +
              `atrim=0:${s.duration.toFixed(3)},adelay=${Math.round(ambStart * 1000)}:all=1${label}`,
          );
          ambLabels.push(label);
          ai += 1;
          ambStart += s.duration - fade;
        }
      }
      // 终局响度标准化（EBU R128 单遍）：对齐流媒体响度目标，成片之间音量一致
      const loudnessChain = 'loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95';
      // v1.4 BGM 铺底链：循环源裁到片长 + 音量 + 首尾淡入淡出；有旁白可选闪避
      const bgmChain = (vol, label = '[bgm]') =>
        `[${bgmIdx}:a]atrim=0:${total.toFixed(2)},volume=${vol},` +
        `afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, total - 3).toFixed(2)}:d=3${label}`;
      // v2.5 终混重构：旁白 / BGM / 镜头原声各自成形后统一 amix（环境声可独立叠加）
      const mixSrc = [];
      if (narrLabels.length) {
        fl.push(`${narrLabels.join('')}amix=inputs=${narrLabels.length}:duration=longest:normalize=0[narmix]`);
        if (bgmIdx >= 0) {
          fl.push(bgmChain(bgmVolume));
          // v1.5 闪避调优：阈值贴旁白电平、中等比率、快攻慢放——说话时音乐让路、句间自然回升
          fl.push('[narmix]asplit=2[narMain][narSc]');
          // v2.4.1 修复：sidechaincompress 输出长度随侧链结束而截断——侧链补静音到片长，
          // 否则「最后一条旁白之后」的 BGM 段整段丢失（成片尾部静音，实测 137.7s 片音频仅 128.4s）
          fl.push(`[narSc]apad=whole_dur=${total.toFixed(2)}[narScP]`);
          fl.push('[bgm][narScP]sidechaincompress=threshold=0.035:ratio=9:attack=40:release=450[bgmD]');
          mixSrc.push('[narMain]', '[bgmD]');
        } else {
          mixSrc.push('[narmix]');
        }
      } else if (bgmIdx >= 0) {
        // 无旁白：BGM 适当抬升音量（保证成片有可听的音乐底）
        fl.push(bgmChain(Math.max(bgmVolume, 0.55), '[bgmSolo]'));
        mixSrc.push('[bgmSolo]');
      }
      if (ambLabels.length) {
        if (ambLabels.length === 1) {
          mixSrc.push(ambLabels[0]);
        } else {
          fl.push(`${ambLabels.join('')}amix=inputs=${ambLabels.length}:duration=longest:normalize=0[ambmix]`);
          mixSrc.push('[ambmix]');
        }
      }
      let aout;
      if (mixSrc.length === 0) {
        aout = `${narrIdxStart}:a`; // 静音源直接作为音轨（直接流映射不能带方括号标签）
      } else if (mixSrc.length === 1) {
        // 末尾 apad 兜底：任何上游短于片长的情形也保证音轨铺满全片
        fl.push(`${mixSrc[0]}${loudnessChain},apad[aout]`);
        aout = '[aout]';
      } else {
        fl.push(
          `${mixSrc.join('')}amix=inputs=${mixSrc.length}:duration=longest:normalize=0,${loudnessChain},apad[aout]`,
        );
        aout = '[aout]';
      }

      const outName = `render-${job.id}-${Date.now()}.mp4`;
      const outPath = path.join(ARTIFACTS_DIR, outName);
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      const totalMs = total * 1000;
      const r = await runFfmpeg(
        [
          ...inputs,
          '-filter_complex',
          fl.join(';'),
          '-map',
          '[vout]',
          '-map',
          aout,
          '-t',
          total.toFixed(2),
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          '18',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          '-progress',
          'pipe:1',
          outPath,
        ],
        {
          totalMs,
          cwd: tmpDir, // subtitles=subs.ass 相对路径 + libass 字体目录
          onProgress: (pct) => renders.update(job.id, { progress: 40 + Math.round(55 * pct) }),
        },
      );
      if (!r.ok) {
        log('error', `渲染任务 #${job.id} 终混失败（stderr）：${r.err.slice(0, 1200)}`);
        return this.fail(
          job.id,
          '成片合成失败（多为个别素材编码/时长异常），请尝试重拍个别镜头后重试，详情见「日志」面板',
        );
      }

      const outDur = probeDuration(outPath) || total;

      /* ---- 5.5) 响度补偿（v1.8.1）：单遍 loudnorm 在稀疏人声内容上会欠校准，
       * 实测综合响度与 -16 LUFS 目标偏差 >1.5dB 时，音轨直补（视频流免重编码），至多两轮 ---- */
      let finalLoudness = null; // P3 质检报告：最终实测响度
      try {
        for (let pass = 0; pass < 2; pass++) {
          const probe = spawnSync(
            'ffmpeg',
            ['-hide_banner', '-nostats', '-i', outPath, '-af', 'ebur128', '-f', 'null', '-'],
            { encoding: 'utf8', timeout: 180_000, windowsHide: true },
          );
          const m = /Integrated loudness:\s*I:\s*(-?\d+\.?\d*)\s*LUFS/.exec(probe.stderr || '');
          if (!m) break;
          finalLoudness = Math.round(Number(m[1]) * 10) / 10;
          const delta = -16 - Number(m[1]);
          if (Math.abs(delta) <= 1.5) {
            log('info', `渲染任务 #${job.id} 响度达标：${Number(m[1])} LUFS`);
            break;
          }
          const tmpA = outPath + '.loud.mp4';
          const r2 = await runFfmpeg([
            '-i',
            outPath,
            '-c:v',
            'copy',
            '-af',
            `volume=${delta.toFixed(1)}dB,alimiter=limit=0.95`,
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-movflags',
            '+faststart',
            tmpA,
          ]);
          if (!r2.ok) {
            log('warn', `响度补偿失败：${r2.err.slice(0, 120)}`);
            break;
          }
          fs.rmSync(outPath, { force: true });
          fs.renameSync(tmpA, outPath);
          log(
            'info',
            `渲染任务 #${job.id} 响度补偿 ${delta > 0 ? '+' : ''}${delta.toFixed(1)}dB（实测 ${Number(m[1])} LUFS → 目标 -16）`,
          );
        }
      } catch (e) {
        log('warn', `响度补偿异常（不影响成片）：${e.message}`);
      }

      /* ---- 6) 封面候选（v1.8：3 张关键帧，第一张叠片名；best-effort 不影响成片） ---- */
      const covers = [];
      try {
        const pickTimes = [0.18, 0.5, 0.82].map((r) => Math.min(Math.max(total * r, 0.5), Math.max(total - 0.4, 0.5)));
        for (let i = 0; i < pickTimes.length; i++) {
          const name = `cover-${job.id}-${i + 1}.png`;
          const cpath = path.join(ARTIFACTS_DIR, name);
          const args = ['-i', outPath, '-ss', pickTimes[i].toFixed(2), '-frames:v', '1'];
          if (i === 0 && font) {
            args.push(
              '-vf',
              `drawtext=fontfile=${font.rel}:text='${escDrawtext(project.name)}':fontsize=${Math.round(dims.w * 0.052)}:fontcolor=0xF2ECDC:borderw=3:bordercolor=0x181410:x=(w-text_w)/2:y=h-text_h-${Math.round(dims.h * 0.06)}`,
            );
          }
          args.push(cpath);
          const r = await runFfmpeg(args, { cwd: tmpDir });
          if (r.ok && fs.existsSync(cpath)) covers.push({ path: cpath, url: `/artifacts/${name}` });
        }
        if (covers.length) log('info', `渲染任务 #${job.id} 生成封面候选 ${covers.length} 张`);
      } catch (e) {
        log('warn', `渲染任务 #${job.id} 封面生成失败（不影响成片）：${e.message}`);
      }

      // P3 质检报告：成片时长 / 响度 / 镜头覆盖 / 旁白覆盖 / 字幕行数 / 时长偏差
      const expectedDuration =
        Math.round(segments.reduce((s, x) => s + (Number(x.nominalSeconds) || 5), 0) * 100) / 100;
      const quality = {
        duration_s: Math.round(outDur * 100) / 100,
        expected_duration_s: expectedDuration,
        duration_deviation_pct:
          expectedDuration > 0 ? Math.round(((outDur - expectedDuration) / expectedDuration) * 1000) / 10 : null,
        loudness_lufs: finalLoudness,
        shots: segments.length,
        narrated_shots: norm.filter((s) => s.narrationPath).length,
        sub_lines: subLines.length,
        transition_type: transitionType,
        subtitle_style: subStyle,
      };
      // v2.5.3 交付封面：从片头卡抽一帧（主/副标题与署名已成图，比"关键帧 + 绘字"更精致；
      // 同时省掉一次 LLM + 文生图调用）
      let titleCardCover = null;
      const headCard = cards.find((c) => c.kind === 'head');
      if (headCard && headCard.file) {
        const coverPath = path.join(tmpDir, 'cover-title.png');
        const rc = await runFfmpeg([
          '-i',
          headCard.file,
          '-ss',
          (TITLE_DUR - 1.2).toFixed(2), // 淡入完成(0.9s)之后、淡出(3.2s)之前
          '-frames:v',
          '1',
          coverPath,
        ]);
        if (rc.ok && fs.existsSync(coverPath)) titleCardCover = coverPath;
        else log('warn', `渲染任务 #${job.id} 片头卡封面抽取失败（不影响成片）：${rc.err.slice(0, 200)}`);
      }
      // v2.2 作品归档：成片/字幕/台词/制作档案/发布文案/封面 → data/works/《项目名》-id/
      // v2.6：归档段追加「发布包/」（B 站 16:9 + 抖音 9:16 竖屏，整包幂等重建）
      const workDir = await archiveWork({
        job,
        project,
        segments,
        subLines,
        outPath,
        titleCardFile: titleCardCover,
      });
      renders.update(job.id, {
        status: 'completed',
        progress: 100,
        output_path: outPath,
        covers,
        quality,
        work_dir: workDir,
      });
      log(
        'info',
        `渲染任务 #${job.id} 完成：《${project.name}》 ${outDur.toFixed(1)}s / ${segments.length} 镜 / 响度 ${finalLoudness ?? '?'} LUFS → ${outPath}${workDir ? `（作品已归档 ${workDir}）` : ''}`,
      );
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 片头卡（v2.4 改版）：优先用项目场景图作背景（压暗 + 暗角，突出主题画面），
   * 叠加「主标题 + 副标题 + 署名」三层文字；无场景图时退回暖褐渐变底。
   * 文字均带描边保证可读性；字体缺失/不含中文能力时降级为纯背景。
   */
  async makeTitleCard(tmpDir, font, texts, sceneSrc, dims = { w: 1280, h: 720 }) {
    const dest = path.join(tmpDir, 'card-title.mp4');
    const vf = [];
    if (sceneSrc) {
      vf.push(`scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},setsar=1`);
      vf.push('eq=brightness=-0.22:saturation=0.9');
      vf.push('vignette=PI/4.2');
    }
    // v2.5.4：视觉重设计（排版/字体见 titleCardFilters——渲染与封面预览同源）
    vf.push(...titleCardFilters({ dims, font, texts: texts || {} }));
    vf.push(`fade=t=in:st=0:d=0.9,fade=t=out:st=${(TITLE_DUR - 0.6).toFixed(1)}:d=0.6`, 'format=yuv420p');
    const inputArgs = sceneSrc
      ? ['-loop', '1', '-i', sceneSrc]
      : [
          '-f',
          'lavfi',
          '-i',
          `nullsrc=s=${dims.w}x${dims.h},geq=lum='8+40*(0.5*X/W+0.5*Y/H)':cb='126+2*X/W':cr='127+6*Y/H',noise=alls=2:allf=t`,
        ];
    const r2 = await runFfmpeg(
      [
        ...inputArgs,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=stereo',
        '-t',
        String(TITLE_DUR),
        '-r',
        String(OUT_FPS),
        '-vf',
        vf.join(','),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        dest,
      ],
      { cwd: tmpDir },
    );
    if (!r2.ok) return { file: null, duration: TITLE_DUR, failed: r2.err };
    return { file: dest, duration: TITLE_DUR };
  }

  /** 片尾卡（v2.4）：场景图压暗 + 「— 完 —」+ 片名 + 署名（无场景图/字体时降级） */
  async makeEndCard(tmpDir, font, texts, sceneSrc, dims = { w: 1280, h: 720 }) {
    const { title = '', creator = '' } = texts || {};
    const dest = path.join(tmpDir, 'card-end.mp4');
    const vf = [
      `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},setsar=1`,
      'eq=brightness=-0.16:saturation=0.88',
      'vignette=PI/5',
    ];
    const canText = font && (font.cjk || !hasCJK(`${title}${creator}`));
    if (canText) {
      vf.push(
        'drawtext=fontfile=' +
          font.rel +
          `:text='— 完 —':fontsize=52:fontcolor=0xF5EFE2:borderw=3:bordercolor=0x14100C:x=(w-text_w)/2:y=(h-text_h)*0.38`,
      );
      if (title) {
        vf.push(
          'drawtext=fontfile=' +
            font.rel +
            `:text='${escDrawtext(title)}':fontsize=26:fontcolor=0xD9CFBE:x=(w-text_w)/2:y=(h-text_h)*0.54`,
        );
      }
      if (creator) {
        vf.push(
          'drawtext=fontfile=' +
            font.rel +
            `:text='${escDrawtext(creator)}':fontsize=22:fontcolor=0xCFC4B0:x=(w-text_w)/2:y=(h-text_h)*0.84`,
        );
      }
    }
    vf.push(`fade=t=in:st=0:d=0.8,fade=t=out:st=${(END_DUR - 0.6).toFixed(1)}:d=0.6`, 'format=yuv420p');
    const inputArgs = sceneSrc
      ? ['-loop', '1', '-i', sceneSrc]
      : ['-f', 'lavfi', '-i', `color=c=0x060A14:s=${dims.w}x${dims.h}`];
    const r = await runFfmpeg(
      [
        ...inputArgs,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=stereo',
        '-t',
        String(END_DUR),
        '-r',
        String(OUT_FPS),
        '-vf',
        vf.join(','),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        dest,
      ],
      { cwd: tmpDir },
    );
    if (!r.ok) return { file: null, duration: END_DUR, failed: r.err };
    return { file: dest, duration: END_DUR };
  }
}

module.exports = new Renderer();
module.exports.collectSegments = collectSegments;
module.exports.hasFfmpeg = hasFfmpeg;
module.exports.escDrawtext = escDrawtext;
module.exports.findFont = findFont; // 预检脚本复用同一字体来源（避免两处候选表漂移）
module.exports.findSerifFont = findSerifFont;
module.exports.stageFont = stageFont;
module.exports.titleCardFilters = titleCardFilters; // 片头卡/封面预览共用（tools/card-preview.js）
module.exports.splitEpisodeLabel = splitEpisodeLabel;
module.exports.buildPublishPackage = buildPublishPackage; // v2.6 多平台发布包（路由手动重生成共用）
module.exports.fillAspect = fillAspect; // v2.6 画幅模糊填充（竖屏切片/封面互转共用）
module.exports.probeSize = probeSize;
