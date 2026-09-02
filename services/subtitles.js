'use strict';
/**
 * services/subtitles.js —— 字幕生成纯函数（M2 从 workers/render.js 拆出）
 * ASS（v1.6 烧录）/ SRT（v2.2 归档）字幕生成 + CJK 预换行工具。
 * 全部无副作用、不依赖 express 与后台 worker，可被单元测试直接引用，
 * 让渲染 worker 模块只保留 ffmpeg 编排流程。
 */
const { SUBTITLE_STYLES, SUBTITLE_POSITIONS } = require('../core/constants');

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
  return String(text || '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 中文按字数预换行（libass 对无空格 CJK 长句不做自动换行，必须显式 \N）；标点不领头 */
function wrapCJK(text, maxChars) {
  const t = assEscape(text);
  const NO_LEAD = '。，、；：？！）」』】》·—…';
  const lines = [];
  for (let i = 0; i < t.length; i += maxChars) lines.push(t.slice(i, i + maxChars));
  // 行首标点回收到上一行行尾（上一行允许超 1–2 字）
  for (let i = 1; i < lines.length; i++) {
    while (lines[i] && NO_LEAD.includes(lines[i][0])) {
      lines[i - 1] += lines[i][0];
      lines[i] = lines[i].slice(1);
    }
  }
  return lines.filter(Boolean).join('\\N');
}

/**
 * 字幕样式预设（v2.0 高级配置）：ASS Style 参数（颜色为 &HAABBGGRR，BGR 反序）
 */
const SUBTITLE_STYLE_DEFS = {
  // 白字深描边（默认）：通用清爽
  'white-outline': {
    primary: '&H00DCECF2',
    outline: '&H00181410',
    back: '&H80000000',
    bold: 1,
    borderStyle: 1,
    outlineW: 2.2,
    shadow: 1.2,
  },
  // 暖金字幕 + 半透明黑底框：综艺/燃向氛围
  'yellow-box': {
    primary: '&H005CD7FF',
    outline: '&H00000000',
    back: '&HC0000000',
    bold: 1,
    borderStyle: 3,
    outlineW: 1.2,
    shadow: 0,
  },
  // 白字 + 更实的底部条：纪录/口播风格
  'bottom-bar': {
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    back: '&HA0000000',
    bold: 1,
    borderStyle: 3,
    outlineW: 1.6,
    shadow: 0,
  },
};

/**
 * 生成 ASS 字幕文件内容（纯函数，供渲染与 e2e 断言）
 * @param {{start:number,end:number,text:string}[]} lines 时间轴（秒）
 * @param {{fontsize?:number, family?:string, playResX?:number, playResY?:number, marginV?:number,
 *          style?:string, position?:string}} [opts] v2.0：style=字幕样式预设，position=bottom|center
 */
function buildSubtitleAss(
  lines,
  {
    fontsize = 42,
    family = 'Microsoft YaHei',
    playResX = 1280,
    playResY = 720,
    marginV = 52,
    style = 'white-outline',
    position = 'bottom',
  } = {},
) {
  const sd = SUBTITLE_STYLE_DEFS[SUBTITLE_STYLES.includes(style) ? style : 'white-outline'];
  const alignment = SUBTITLE_POSITIONS.includes(position) && position === 'center' ? 5 : 2; // numpad：2=底部居中 5=屏幕居中
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Narr,${family},${fontsize},${sd.primary},&H000000FF,${sd.outline},${sd.back},${sd.bold},0,0,0,100,100,0,0,${sd.borderStyle},${sd.outlineW},${sd.shadow},${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const events = (lines || [])
    .filter((l) => l && l.text && l.end > l.start)
    .map((l) => {
      // 每行可容纳字数 ≈ 可用宽度 / 字号（留边距 60×2），至少 10 字
      const maxChars = Math.max(10, Math.floor((playResX - 120) / fontsize) - 1);
      const text = wrapCJK(l.text, maxChars);
      return `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Narr,,0,0,0,,{\\fad(150,150)}${text}`;
    });
  return header + '\n' + events.join('\n') + (events.length ? '\n' : '');
}

/** v2.2：SRT 字幕生成（纯函数，作品归档用——社交平台/剪辑软件通用格式）
 * @param {{start:number,end:number,text:string}[]} lines 时间轴（秒，与成片对齐） */
function buildSrt(lines) {
  const fmt = (t) => {
    const ms = Math.max(0, Math.round((Number(t) || 0) * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
  };
  return (lines || [])
    .filter((l) => l && l.text && l.end > l.start)
    .map((l, i) => `${i + 1}\n${fmt(l.start)} --> ${fmt(l.end)}\n${String(l.text).replace(/\r?\n/g, ' ')}\n`)
    .join('\n');
}

module.exports = { buildSubtitleAss, buildSrt };
