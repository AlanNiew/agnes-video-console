'use strict';
/**
 * poster.js —— 社交平台海报生成器（v2.2）
 * 渲染完成后为作品自动生成一张可发社交平台的海报：
 *   ① LLM 基于项目创意/风格/梗概产出「电影海报级」文生图提示词（画面不含文字）
 *   ② agnes-image 文生图出底图（画幅跟随项目）
 *   ③ ffmpeg drawtext 叠项目名大标题（字体复制到工作目录用相对路径引用，
 *      规避 Windows 盘符冒号与滤镜参数冲突——与渲染器 stageFont 同方案）
 * 产物落作品目录 海报.png。全程 best-effort：任一步失败仅记 warn，绝不影响成片。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { settings, DEFAULT_SETTINGS, projects } = require('../db');
const agnes = require('../clients/agnes');
const { log } = require('../core/logger');
const { IMAGE_MODEL, LLM_MODEL } = require('../core/constants');

const POSTER_SYSTEM_PROMPT = `你是电影海报艺术指导。根据用户的视频创意、风格与故事梗概，输出一条可直接用于 AI 文生图的海报提示词。
要求：①单一主视觉主体（人物/道具/场景三选一，最代表故事内核），构图有冲击力、情绪浓度高；②光线戏剧化（逆光剪影/丁达尔光/霓虹/晨昏光等与故事匹配）；③画面下方或上方留出约四分之一的视觉呼吸区（供后期叠加标题），但画面本身不包含任何文字、字母、数字；④延续视频的美术风格关键词；⑤120~200 字，具体可绘制，禁止抽象形容。只输出提示词本身，不要任何解释或引号。`;

/** 运行一次 ffmpeg（-y -nostdin 防死锁，与渲染器 runFfmpeg 同规则；cwd 供 drawtext 相对路径字体） */
function runFfmpegOnce(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin', '-y', ...args], {
      windowsHide: true,
      cwd,
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ ok: false, err: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, err: err.trim() }));
  });
}

/** 海报标题字体（与 render.js findFont 同源候选表；独立实现避免循环依赖） */
function findPosterFont() {
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

/** drawtext 文本转义（与 render.js escDrawtext 同规则：\ % ' :） */
function escDrawtext(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

/**
 * 为项目生成社交海报并写入作品目录（fire-and-forget 调用，失败不抛出）
 * @param {object} project 项目行（name/idea/style；梗概自动取 selectedText）
 * @param {string} workDir 作品目录绝对路径
 * @param {string} aspect 项目画幅（海报跟随：9:16/3:4 竖版，其余 16:9 横版）
 */
async function generatePoster(project, workDir, aspect) {
  const tag = `海报《${project.name}》`;
  const tmpFiles = []; // 清理清单（底图/临时字体）
  try {
    const apiKey = settings.get('api_key', '');
    if (!apiKey) return log('warn', `${tag} 跳过：未配置 API Key`);
    const baseUrl = settings.get('base_url', DEFAULT_SETTINGS.base_url);

    // ① 海报提示词（LLM；故事梗概增强语境）
    const script = projects.selectedText(project.id, 'script')?.content || '';
    const userMessage = `视频名：《${project.name}》\n创意：${project.idea || ''}\n风格：${project.style || '不限制'}\n故事梗概：${script || '（无）'}\n海报画幅：${aspect || '16:9'}`;
    const chat = await agnes.chatComplete({
      apiKey,
      baseUrl,
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: POSTER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.8,
      max_tokens: 1000,
    });
    if (!chat.ok) throw new Error(`LLM 失败（${chat.status}）`);
    const prompt = String(chat.data?.choices?.[0]?.message?.content || '')
      .trim()
      .slice(0, 800);
    if (!prompt) throw new Error('LLM 未返回海报提示词');

    // ② 文生图底图（画幅跟随项目）
    const ratio = ['9:16', '3:4'].includes(String(aspect)) ? String(aspect) : '16:9';
    const img = await agnes.generateImage({
      apiKey,
      baseUrl,
      payload: { model: IMAGE_MODEL, prompt, size: '2K', ratio, extra_body: { response_format: 'url' } },
    });
    if (!img.ok) throw new Error(`文生图失败（${img.status}）`);
    const imgUrl = img.data?.data?.[0]?.url;
    if (!imgUrl || !/^https?:\/\//i.test(imgUrl)) throw new Error('文生图未返回有效 URL');

    // ③ 下载底图 → drawtext 叠项目名 → 海报.png（字体复制到 workDir 走相对路径，规避盘符冒号）
    const res = await fetch(imgUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`底图下载失败（HTTP ${res.status}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error('底图数据异常（过小）');
    const baseName = `.poster-base-${Date.now()}.png`;
    fs.writeFileSync(path.join(workDir, baseName), buf);
    tmpFiles.push(baseName);

    const dims =
      ratio === '9:16' ? { w: 1080, h: 1920 } : ratio === '3:4' ? { w: 1080, h: 1440 } : { w: 1920, h: 1080 };
    let vf = `scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},setsar=1`;
    const fontSrc = findPosterFont();
    if (fontSrc) {
      const fontRel = '.poster-font' + path.extname(fontSrc);
      fs.copyFileSync(fontSrc, path.join(workDir, fontRel));
      tmpFiles.push(fontRel);
      // 标题：底部半透明衬底 + 大字 + 深色描边，任何画面都可读
      //（drawbox/drawtext 用具体像素值——drawtext 的 y 表达式不支持 ih/iw，混用会 Eval 报错）
      const fsize = Math.round(dims.w * (dims.h > dims.w ? 0.085 : 0.06));
      const boxTop = Math.round(dims.h * 0.78);
      const boxH = dims.h - boxTop;
      const textBottomGap = Math.round(dims.h * 0.07);
      vf +=
        `,drawbox=y=${boxTop}:h=${boxH}:color=black@0.45:t=fill` +
        `,drawtext=fontfile=${fontRel}:text='${escDrawtext(project.name)}':fontsize=${fsize}:fontcolor=0xF2ECDC:borderw=4:bordercolor=0x10131A:x=(w-text_w)/2:y=h-text_h-${textBottomGap}`;
    }
    const r = await runFfmpegOnce(['-i', baseName, '-vf', vf, '海报.png'], workDir);
    if (!r.ok) throw new Error(`标题合成失败：${r.err.slice(0, 150)}`);
    log(
      'info',
      `${tag} 已生成 → ${path.join(workDir, '海报.png')}（${ratio}${fontSrc ? ' · 含标题' : ' · 无中文字体，纯画面'}）`,
    );
  } catch (e) {
    log('warn', `${tag} 生成失败（不影响成片）：${e.message}`);
  } finally {
    for (const f of tmpFiles) {
      try {
        fs.rmSync(path.join(workDir, f), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { generatePoster, POSTER_SYSTEM_PROMPT };
