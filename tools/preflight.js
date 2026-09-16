#!/usr/bin/env node
'use strict';
/**
 * tools/preflight.js —— 开工预检（10 秒判定"今天能不能开工"）
 *
 * 为什么需要：E03 期间 90% 的痛苦来自「没人告诉我网络只有 48 KB/s」——
 * CDN 拉取速率直接决定归档与渲染能不能跑；而服务进程若缺 FISH_PROXY，逐镜配音会整体 502。
 *
 * 检查项：
 *   1) 服务健康（/api/health）+ 响应延迟
 *   2) 设置完整性（API Key / Fish Key / **服务侧 FISH_PROXY** / 音乐 token）
 *   3) ffmpeg + ffprobe（渲染与时长探测的硬依赖）
 *   4) 中文字体（缺则片头/片尾卡文字静默丢失）
 *   5) 数据目录可写 + 磁盘剩余空间
 *   6) **CDN 下载速率**（用最近已完成任务的产物实测 8MB/20s 预算）
 *
 * 用法：node tools/preflight.js（或 npm run preflight）
 * 退出码：0 = 可以开工；1 = 存在致命项
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASE = process.env.AGNES_BASE || 'http://127.0.0.1:8273';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });

async function api(pathname) {
  const res = await fetch(BASE + pathname, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function cmd(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || r.stderr || '');
}

/* 1) 服务健康 */
async function checkService() {
  const t0 = Date.now();
  try {
    const h = await api('/api/health');
    const ms = Date.now() - t0;
    add(ms > 1500 ? 'warn' : 'ok', '服务', `${h.app} · 已运行 ${Math.round(h.uptime_s / 60)} 分钟 · 响应 ${ms}ms`);
    return true;
  } catch (e) {
    add('bad', '服务', `无法访问 ${BASE}（${e.message}）——请先启动：npm start`);
    return false;
  }
}

/* 2) 设置完整性 */
async function checkSettings(serviceUp) {
  if (!serviceUp) {
    add('warn', '设置', '服务未启动，跳过');
    return;
  }
  try {
    const s = await api('/api/settings');
    if (!s.api_key_set) add('bad', 'Agnes API Key', '未配置——所有生成都会失败（设置页填写）');
    else add('ok', 'Agnes API Key', '已配置');
    if (!s.fish_api_key_set) add('bad', 'Fish API Key', '未配置——配音全部失败（设置页填写）');
    else add('ok', 'Fish API Key', '已配置');
    if (s.fish_proxy_set) add('ok', 'Fish 代理（服务进程）', 'FISH_PROXY 已注入');
    else
      add(
        'warn',
        'Fish 代理（服务进程）',
        'FISH_PROXY 未注入——若配音报"网络异常 502"，请带环境变量重启服务' +
          '（PowerShell: $env:FISH_PROXY="127.0.0.1:7897" 后再 Start-Process）',
      );
    if (!s.music_api_token_set) add('warn', 'BGM 音乐 token', '未配置——无法搜歌/选 BGM');
    else add('ok', 'BGM 音乐 token', '已配置');
    add(
      s.video_auto_download ? 'ok' : 'warn',
      '视频自动下载',
      s.video_auto_download ? '已开启（完成即本地归档）' : '未开启——远端链接会过期，重渲可能失败',
    );
  } catch (e) {
    add('warn', '设置', `读取失败：${e.message}`);
  }
}

/* 3) 二进制依赖 */
function checkBinaries() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const out = cmd(bin, ['-version']);
    if (!out) add('bad', bin, '未安装或不在 PATH（渲染/时长探测不可用）');
    else add('ok', bin, (out.split('\n')[0] || '').slice(0, 60));
  }
}

/* 4) 中文字体（与渲染共用同一来源，见 workers/render.js findFont） */
function checkFont() {
  try {
    const font = require('../workers/render').findFont();
    if (font) add('ok', '中文字体', path.basename(font));
    else add('bad', '中文字体', '未找到可用中文字体——片头/片尾卡文字会被静默跳过');
  } catch (e) {
    add('warn', '中文字体', `检测失败：${e.message}`);
  }
}

/* 5) 数据目录 + 磁盘 */
function checkDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, '.preflight-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    add('ok', '数据目录', `可写：${DATA_DIR}`);
  } catch (e) {
    add('bad', '数据目录', `不可写：${e.message}`);
  }
  try {
    const st = fs.statfsSync(DATA_DIR);
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    if (freeGb < 2) add('bad', '磁盘剩余', `${freeGb.toFixed(1)} GB——渲染会中断，请先清理`);
    else if (freeGb < 5) add('warn', '磁盘剩余', `${freeGb.toFixed(1)} GB——建议清理（成片约 60MB/集）`);
    else add('ok', '磁盘剩余', `${freeGb.toFixed(1)} GB`);
  } catch (e) {
    add('warn', '磁盘剩余', `无法读取：${e.message}`);
  }
}

/* 6) CDN 下载速率（真实测速：取最近已完成任务的产物，限 8MB / 20s） */
async function checkCdnSpeed(serviceUp) {
  if (!serviceUp) {
    add('warn', 'CDN 速率', '服务未启动，跳过');
    return;
  }
  let url = null;
  try {
    const list = await api('/api/tasks?status=completed&limit=10');
    url = (list.items || []).map((t) => t.metadata_url).find((u) => /^https?:\/\//.test(u || '')) || null;
  } catch (e) {
    add('warn', 'CDN 速率', `取测试样本失败：${e.message}`);
    return;
  }
  if (!url) {
    add('warn', 'CDN 速率', '无已完成任务可作样本——先跑一集再测');
    return;
  }
  const budgetMs = 20000;
  const maxBytes = 8 * 1024 * 1024;
  const t0 = Date.now();
  let bytes = 0;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(budgetMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes >= maxBytes || Date.now() - t0 > budgetMs) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  } catch (e) {
    if (!bytes) {
      add('bad', 'CDN 速率', `无法拉取产物（${e.message}）——检查代理/TUN；弱网会让渲染与归档极慢`);
      return;
    }
  }
  const kbps = Math.round(bytes / 1024 / ((Date.now() - t0) / 1000));
  const detail = `≈${kbps} KB/s（样本 ${(bytes / 1048576).toFixed(1)}MB）`;
  if (kbps >= 800) add('ok', 'CDN 速率', detail + ' — 正常，渲染/归档顺畅');
  else if (kbps >= 200) add('warn', 'CDN 速率', detail + ' — 偏慢，渲染会明显变慢（建议开代理 TUN）');
  else add('bad', 'CDN 速率', detail + ' — 过慢！渲染会卡在远端素材读取（历史事故：48 KB/s 时进度冻结 30 分钟）');
}

(async () => {
  console.log(`\n开工预检 · ${BASE} · ${new Date().toLocaleString('zh-CN')}\n`);
  const serviceUp = await checkService();
  await checkSettings(serviceUp);
  checkBinaries();
  checkFont();
  checkDisk();
  await checkCdnSpeed(serviceUp);

  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' };
  for (const r of rows) console.log(`${icon[r.level]} ${r.name.padEnd(22, ' ')} ${r.detail}`);

  const bad = rows.filter((r) => r.level === 'bad').length;
  const warn = rows.filter((r) => r.level === 'warn').length;
  console.log(
    bad
      ? `\n结论：**请先修 ${bad} 个致命项**（另有 ${warn} 项提示）——不修会在生产中途失败。\n`
      : `\n结论：可以开工${warn ? `（${warn} 项提示，非阻塞）` : ''}。\n`,
  );
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('预检异常：', e.message);
  process.exit(1);
});
