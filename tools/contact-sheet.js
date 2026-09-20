#!/usr/bin/env node
'use strict';
/**
 * 抽帧对比网格（质检工具）
 *
 * 用途：把项目各镜（或指定任务）的视频各抽一帧、拼成一张网格图，用于**跨镜一致性质检**
 *（人物脸/服色/核心道具/风格/字幕）——比逐个点开视频快一个数量级，是「两遍质检」第一遍的主力工具。
 *
 * 用法：
 *   node tools/contact-sheet.js --project 48                     # 全镜（定稿 take 优先，无则取最新完成条）
 *   node tools/contact-sheet.js --project 48 --shots 8-12        # 只筛某段（如记忆段）
 *   node tools/contact-sheet.js --tasks 613,614,615              # 直接给任务 id（对比候选 take）
 *   node tools/contact-sheet.js --project 48 --cols 4 --at 0.55 --width 480 --out sheet.png
 *
 * 参数：--api（默认 http://127.0.0.1:8273）· --cols 列数 · --at 抽帧位置（片长比例，默认 0.55）
 *      --width 单帧宽（默认 480）· --out 输出路径（默认临时目录）
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
}
const API = (args.api || 'http://127.0.0.1:8273').replace(/\/$/, '');
const COLS = Math.max(1, Math.min(6, Number(args.cols) || 4));
const AT = Math.min(0.95, Math.max(0.02, Number(args.at) || 0.55));
const WIDTH = Math.max(160, Number(args.width) || 480);
const OUT = args.out || path.join(os.tmpdir(), `contact-sheet-${Date.now()}.png`);

/** 解析镜头序号筛选（支持 "1-5,8,12-14"） */
function parseSeqFilter(spec) {
  if (!spec) return null;
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const p = part.trim();
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
    if (m) for (let n = Number(m[1]); n <= Number(m[2]); n += 1) set.add(n);
    else if (/^\d+$/.test(p)) set.add(Number(p));
  }
  return set;
}

const takeOk = (t) => Boolean(t && t.status === 'completed' && t.video_local_path && fs.existsSync(t.video_local_path));

(async () => {
  const items = []; // {seq,label,file,seconds}

  if (args.tasks) {
    for (const id of String(args.tasks)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const t = await fetch(`${API}/api/tasks/${id}`).then((r) => r.json());
      if (takeOk(t))
        items.push({
          seq: t.shot_seq ?? 0,
          label: `镜${t.shot_seq ?? '?'} · #${t.id}`,
          file: t.video_local_path,
          seconds: t.seconds,
        });
      else console.error(`跳过任务 #${id}（无本地视频：${t.status}）`);
    }
  } else if (args.project) {
    const p = await fetch(`${API}/api/projects/${args.project}`).then((r) => r.json());
    if (!p || !p.shots) {
      console.error(`项目 #${args.project} 不存在或不可读`);
      process.exit(1);
    }
    const filter = parseSeqFilter(args.shots);
    const shots = p.shots.slice().sort((a, b) => a.seq - b.seq);
    for (const s of shots) {
      if (filter && !filter.has(s.seq)) continue;
      const tasks = p.tasks || [];
      let t = tasks.find((x) => x.id === s.take_task_id); // 定稿 take 优先
      if (!takeOk(t)) t = tasks.filter((x) => x.shot_id === s.id && takeOk(x)).sort((a, b) => b.id - a.id)[0]; // 否则最新完成条
      if (!takeOk(t)) {
        console.error(`跳过镜${s.seq}（无可用视频）`);
        continue;
      }
      items.push({
        seq: s.seq,
        label: `镜${s.seq}${s.title ? ` ${s.title}` : ''}`,
        file: t.video_local_path,
        seconds: t.seconds || s.seconds,
      });
    }
  } else {
    console.error(
      '用法：node tools/contact-sheet.js --project <id> [--shots 1-5,8] [--cols 4] [--at 0.55] [--out sheet.png]',
    );
    console.error('  或：node tools/contact-sheet.js --tasks <id,id,...>');
    process.exit(1);
  }

  if (!items.length) {
    console.error('没有可抽帧的视频');
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-sheet-'));
  try {
    items.forEach((it, i) => {
      const out = path.join(tmp, `f-${String(i + 1).padStart(3, '0')}.png`);
      const ss = Math.max(1, (Number(it.seconds) || 10) * AT).toFixed(2);
      execFileSync(
        'ffmpeg',
        ['-y', '-nostdin', '-ss', ss, '-i', it.file, '-frames:v', '1', '-vf', `scale=${WIDTH}:-1`, out],
        { stdio: 'ignore' },
      );
      it.frame = out;
      console.log(`抽帧 ${it.label}（${path.basename(it.file)}）`);
    });
    const rows = Math.ceil(items.length / COLS);
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-nostdin',
        '-framerate',
        '1',
        '-i',
        path.join(tmp, 'f-%03d.png'),
        '-vf',
        `tile=${COLS}x${rows}:padding=4:color=black`,
        OUT,
      ],
      { stdio: 'ignore' },
    );
    console.log(`\n✅ 抽帧网格已生成（${items.length} 帧 · ${COLS} 列）→ ${OUT}`);
    console.log('   质检要点：人物脸/服色 · 核心道具（颜色/构造/形态）· 风格统一 · 场景连戏');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
