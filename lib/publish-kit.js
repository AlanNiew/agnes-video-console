'use strict';
/**
 * publish-kit.js —— 发布物料自动生成（B站等平台的一键复制文案）
 *
 * 数据来源：
 *   - 项目（名称 / 创意 / 风格）+ 渲染任务（规格、时长）→ 事实性内容
 *   - 字幕 SRT → 「看点时间轴」（mm:ss 与成片时间轴一致）
 *   - tools/publish/*.json → 人工策展文案（标题候选 / 简介 / 标签 / 置顶评论）
 *
 * 输出：作品目录下的「发布文案-N.md」，可直接复制到发布页。
 */
const fs = require('node:fs');
const path = require('node:path');
const { safeProjectName } = require('./artifacts');

const PUBLISH_DIR = path.join(__dirname, '..', 'tools', 'publish');

/** 读取本项目的策展文案（按 project_id 或项目名匹配 tools/publish/*.json；无则返回 null） */
function findPublishMeta(project) {
  try {
    if (!fs.existsSync(PUBLISH_DIR)) return null;
    for (const f of fs.readdirSync(PUBLISH_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(PUBLISH_DIR, f), 'utf8'));
        if (m?.match?.project_id != null && Number(m.match.project_id) === Number(project.id)) return m;
        if (m?.match?.name && String(m.match.name) === String(project.name)) return m;
      } catch {
        /* 跳过单个坏文件 */
      }
    }
  } catch {
    /* 目录不可读 */
  }
  return null;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 从 SRT 解析看点时间轴（每行：mm:ss + 该句字幕首行=中文） */
function timelineFromSrt(srt, limit = 20) {
  const out = [];
  for (const block of String(srt || '').split(/\r?\n\r?\n/)) {
    const m = /(\d{2}):(\d{2}):(\d{2}),\d{3}\s*-->/.exec(block);
    if (!m) continue;
    const text = block
      .split(/\r?\n/)
      .map((x) => x.replace(/^\ufeff/, '').trim())
      .find((x) => x && !/^\d+$/.test(x) && !x.includes('-->'));
    if (!text) continue;
    const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    out.push(`- ${fmtTime(sec)} ${text}`);
    if (out.length >= limit) break;
  }
  return out;
}

/** 生成发布文案 Markdown（策展缺失时退化为项目事实的草稿） */
function buildPublishKit({ project, job, srt, segments = [], coverFile = '封面.png' }) {
  const meta = findPublishMeta(project) || {};
  const q = (job && job.quality) || {};
  const jobId = job ? job.id : '?';
  const dur = q.duration_s ? fmtDuration(q.duration_s) : '?';
  const filmFile = `${safeProjectName(project, '成片')}-${jobId}.mp4`; // v2.6.5 成片文件名用作品名
  const L = [];
  let n = 0;
  const section = (title) => {
    n += 1;
    L.push(`## ${['一', '二', '三', '四', '五', '六', '七', '八', '九'][n - 1] || n}、${title}`, '');
  };

  L.push(`# 《${project.name}》发布文案（渲染 #${jobId}）`, '');
  L.push('> 自动生成：策展文案来自 `tools/publish/`，事实项来自项目与渲染任务。可直接复制发布。', '');

  section('标题（择一，B 站上限 80 字）');
  const titles = (meta.titles || []).filter(Boolean);
  if (titles.length) titles.forEach((t, i) => L.push(`${i + 1}. ${t}`));
  else L.push(`1. ${project.name}`);
  L.push('');

  section('简介（直接粘贴）');
  const intro = (meta.intro || []).filter(Boolean);
  if (intro.length) {
    for (const p of intro) L.push(p, '');
  } else if (project.idea) {
    L.push(String(project.idea).trim(), '');
  }
  L.push(
    `- 本集规格：${q.shots ?? segments.length} 镜 · ${dur} · 1280×720 · 30fps · 中日双语字幕`,
    meta.series
      ? `- 系列：${meta.series}${meta.episode ? ` · 本集 ${meta.episode}${meta.episode_title ? `《${meta.episode_title}》` : ''}` : ''}`
      : '',
  );
  for (const c of meta.credits || []) L.push(`- ${c}`);
  L.push('');

  section('标签（逗号分隔，B 站最多 10 个）');
  L.push((meta.tags || []).join('、') || '—', '');

  section('发布设置');
  L.push(
    `- 分区：${meta.category || '动画 → 综合动画'}`,
    `- 合集 / 系列：${meta.collection || meta.series || '—'}`,
    `- 封面：${coverFile}（同目录）· 成片：${filmFile} · ${dur}`,
    meta.cover_hint ? `- 封面建议：${meta.cover_hint}` : '',
    '',
  );

  if (meta.pinned_comment) {
    section('置顶评论');
    L.push(meta.pinned_comment, '');
  }

  const tl = timelineFromSrt(srt);
  if (tl.length) {
    section('看点时间轴（可放简介末尾或置顶评论）');
    L.push(...tl, '');
  }

  return L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
}

module.exports = { buildPublishKit, findPublishMeta, timelineFromSrt };
