#!/usr/bin/env node
'use strict';
/**
 * tools/db-relocate.js —— 库内「本地产物绝对路径」跨机迁移工具
 *
 * 为什么需要：控制台把本地产物的**绝对路径**写进了库
 *   tasks.video_local_path（视频归档）/ project_images.local_path（图片归档）
 *   / project_tts.local_path（配音）/ projects.bgm（JSON 里的 local_path）
 *   / settings.character_library 等 JSON 设置里的 local_path
 * 例：D:\Programing\AI_Video_Create\agnes-video-console\data\artifacts\a123.mp4
 * （另有历史遗留前缀 ...\agnes-video-console\lib\data\artifacts\…——v2.2 的写歪 bug，
 *   见 lib/artifacts.js 注释。--from 可重复给多个前缀。）
 * 这份库换到另一台机器（Windows→Linux）后这些路径全部失效。
 *
 * 四种模式：
 *   report（默认）      只列出库里出现的路径前缀分布，帮你决定 --from 给哪些。
 *   rewrite            把 --from 前缀换成 --to，并把目录分隔符统一成 --to 的风格。
 *                      不会把"非空但文件缺失"变成 NULL，因此**不会**触发 poller 的
 *                      历史归档补扫（db/sql.js: completedWithoutLocal 只挑空的）。
 *   clear-missing      文件确实不存在的记录置 NULL（前端自动回退远端 URL）。
 *                      ⚠ tasks.video_local_path 置空会触发 poller「归档补扫」重新下载
 *                      全部历史任务，故默认不动 tasks，需显式 --include-tasks。
 *   assets             把库里**被引用**的产物按 basename 汇总到暂存目录，供一次 scp 补传。
 *                      默认四组参考素材：角色库图 / BGM 缓存 / 逐镜配音 / 项目图片
 *                      （全库实测约 700 MB）；加 --include-videos 再带上
 *                      tasks.video_local_path（约 +1.8 GB，换来历史项目可重渲）。
 *
 * 写库/写文件都默认 dry-run，确认后加 --apply。写库前务必先快照：
 *   node tools/db-snapshot.js
 *
 * 用法：
 *   node tools/db-relocate.js                                   # 看前缀分布
 *   node tools/db-relocate.js --from 'D:\...\data' --from 'D:\...\lib\data' \
 *        --to '/home/alan/ai-video/data'                        # dry-run
 *   ... 同上再加 --apply
 *   node tools/db-relocate.js --mode clear-missing --apply [--include-tasks]
 *   node tools/db-relocate.js --mode assets --out ../deploy/assets        # 看体积
 *   node tools/db-relocate.js --mode assets --out ../deploy/assets --apply
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/** 裸文本路径列（可直接在 SQL 里做分隔符归一化） */
const TEXT_TARGETS = [
  { table: 'tasks', column: 'video_local_path', pk: 'id', heavy: true },
  { table: 'project_images', column: 'local_path', pk: 'id', heavy: false },
  { table: 'project_tts', column: 'local_path', pk: 'id', heavy: false },
];
/** JSON 文本列（交给 JS 精确改写，避免误伤 JSON 里的其它反斜杠转义） */
const JSON_TARGETS = [
  { table: 'projects', column: 'bgm', pk: 'id' },
  { table: 'settings', column: 'value', pk: 'key' },
];

function argOf(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function argsOf(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}
const has = (n) => process.argv.includes(n);

const apply = has('--apply');
const dryRun = !apply;
const includeTasks = has('--include-tasks');
const includeVideos = has('--include-videos');
const outDir = argOf('--out', '');
const froms = argsOf('--from');
const to = argOf('--to', '');
let mode = argOf('--mode', '');
if (!mode) mode = froms.length ? 'rewrite' : 'report';
const dbPath = path.resolve(
  argOf('--db') ||
    process.env.DB_PATH ||
    path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'agnes-console.db'),
);

const posix = (s) => String(s).replace(/\\/g, '/');
const WIN_ABS = /[A-Za-z]:[\\/]/;

if (!['report', 'rewrite', 'clear-missing', 'assets'].includes(mode)) {
  console.error(`✗ 未知 --mode：${mode}（可选 report | rewrite | clear-missing | assets）`);
  process.exit(2);
}
if (mode === 'rewrite' && (!froms.length || !to)) {
  console.error("✗ rewrite 需要 --from（可重复）与 --to，例如：--from 'D:\\x\\data' --to '/home/alan/ai-video/data'");
  process.exit(2);
}
if (mode === 'assets' && !outDir) {
  console.error('✗ assets 需要 --out，例如：--mode assets --out ../deploy/assets');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error(`✗ 库不存在：${dbPath}`);
  process.exit(1);
}

const normalizeSep = to.includes('/'); // --to 是 posix 风格时才把分隔符统一成 /
/** 每个 --from 同时保留「原样」与「posix 归一化」两种写法：库里两种都可能存在 */
const maps = froms.map((f) => ({ raw: String(f), from: posix(f), to: posix(to) })).filter((m) => m.from);
const db = new DatabaseSync(dbPath, { readOnly: dryRun });

console.log(`库：${dbPath}`);
console.log(`模式：${mode}${dryRun ? '（dry-run，不写库/不写盘）' : '（--apply）'}`);
for (const m of maps) console.log(`映射：${m.from}  →  ${m.to}`);
if (mode === 'clear-missing') console.log(`分隔符归一化：${normalizeSep ? '开' : '关'}`);
console.log('');

/* ------------------------------ report ------------------------------ */
function tally(values) {
  const m = new Map();
  for (const v of values) {
    if (!v || !WIN_ABS.test(String(v))) continue;
    const key = posix(v).split('/').slice(0, 4).join('/'); // 只到前 4 段，避免噪音
    m.set(key, (m.get(key) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

if (mode === 'report') {
  for (const t of TEXT_TARGETS) {
    const rows = db.prepare(`SELECT ${t.column} v FROM ${t.table} WHERE ${t.column} IS NOT NULL`).all();
    const dist = tally(rows.map((r) => r.v));
    console.log(`${t.table}.${t.column}（${rows.length} 行非空）`);
    if (!dist.length) console.log('    （无 Windows 绝对路径）');
    for (const [k, n] of dist.slice(0, 6)) console.log(`    ${String(n).padStart(5)}  ${k}`);
  }
  for (const t of JSON_TARGETS) {
    const rows = db.prepare(`SELECT ${t.column} v FROM ${t.table} WHERE ${t.column} IS NOT NULL`).all();
    const hits = [];
    for (const r of rows) {
      for (const s of walkStrings(r.v)) if (WIN_ABS.test(s)) hits.push(s);
    }
    const dist = tally(hits);
    console.log(`${t.table}.${t.column}（${rows.length} 行，含 ${hits.length} 个 Windows 路径字符串）`);
    for (const [k, n] of dist.slice(0, 6)) console.log(`    ${String(n).padStart(5)}  ${k}`);
  }
  db.close();
  console.log('\n下一步：把上面出现的前缀逐个用 --from 传入（同一 --to）跑 rewrite dry-run。');
  process.exit(0);
}

/* --------------------- JSON 字符串遍历（精确改写） --------------------- */
function walkStrings(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return []; // 非 JSON（如 settings 里的普通字符串）不在这里处理
  }
  const out = [];
  const visit = (node) => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === 'object') return Object.values(node).forEach(visit);
  };
  visit(data);
  return out;
}

function rewriteJsonStrings(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { text, changed: 0 };
  }
  let changed = 0;
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) node[k] = visit(node[k]);
      return node;
    }
    if (typeof node !== 'string') return node;
    let s = node;
    if (WIN_ABS.test(s)) s = posix(s);
    for (const m of maps) if (s.startsWith(m.from)) s = m.to + s.slice(m.from.length);
    if (s !== node) changed += 1;
    return s;
  };
  const next = visit(data);
  return { text: changed ? JSON.stringify(next) : text, changed };
}

/* ---------------------- assets：汇总被引用的产物 ---------------------- */
if (mode === 'assets') {
  const chRow = db.prepare("SELECT value FROM settings WHERE key='character_library'").get();
  const bgmStrs = [];
  for (const r of db.prepare('SELECT bgm v FROM projects WHERE bgm IS NOT NULL').all()) {
    bgmStrs.push(...walkStrings(String(r.v)));
  }
  const isLocal = (p) => Boolean(p) && !/^https?:/i.test(String(p)); // 远端 URL 也常以 .png 结尾，一律排除
  const groups = [
    {
      name: '角色库图',
      paths: (chRow ? walkStrings(String(chRow.value)) : []).filter(
        (s) => isLocal(s) && /\.(png|jpe?g|webp)$/i.test(s),
      ),
    },
    { name: 'BGM 缓存', paths: bgmStrs.filter((s) => isLocal(s) && /\.(mp3|wav|m4a|ogg)$/i.test(s)) },
    {
      name: '逐镜配音',
      paths: db
        .prepare('SELECT local_path v FROM project_tts WHERE local_path IS NOT NULL')
        .all()
        .map((r) => r.v)
        .filter(isLocal),
    },
    {
      name: '项目图片',
      paths: db
        .prepare('SELECT local_path v FROM project_images WHERE local_path IS NOT NULL')
        .all()
        .map((r) => r.v)
        .filter(isLocal),
    },
  ];
  if (includeVideos) {
    groups.push({
      name: '镜头视频',
      paths: db
        .prepare('SELECT video_local_path v FROM tasks WHERE video_local_path IS NOT NULL')
        .all()
        .map((r) => r.v)
        .filter(isLocal),
    });
  }

  const dest = path.resolve(outDir);
  const seenSrc = new Set();
  const seenName = new Map();
  const plan = [];
  let totalBytes = 0;
  let totalMissing = 0;
  for (const g of groups) {
    let n = 0;
    let bytes = 0;
    let miss = 0;
    for (const p of g.paths) {
      if (!p) continue;
      const src = path.resolve(posix(p));
      if (seenSrc.has(src)) continue;
      seenSrc.add(src);
      let st = null;
      try {
        st = fs.statSync(src);
      } catch {
        /* 文件不存在：保持 null */
      }
      if (!st || !st.isFile()) {
        miss += 1;
        totalMissing += 1;
        continue;
      }
      const name = path.basename(src);
      if (seenName.has(name) && seenName.get(name) !== src) {
        console.log(`  ⚠ 同名不同文件（后者会覆盖前者）：${name}`);
      }
      seenName.set(name, src);
      n += 1;
      bytes += st.size;
      totalBytes += st.size;
      plan.push({ src, name });
    }
    console.log(
      `${g.name.padEnd(10)} ${String(n).padStart(4)} 个文件 ${(bytes / 1048576).toFixed(1).padStart(8)} MB` +
        (miss ? `（另有 ${miss} 个文件已被删除/缺失，跳过）` : ''),
    );
  }
  console.log(
    `\n合计（跨组去重后）：${plan.length} 个文件，${(totalBytes / 1048576).toFixed(1)} MB${totalMissing ? `，跳过缺失 ${totalMissing} 个` : ''}`,
  );
  console.log(`暂存目录：${dest}`);
  if (dryRun) {
    console.log('\n（dry-run）体积可接受后加 --apply 复制到暂存目录');
  } else {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of plan) fs.copyFileSync(f.src, path.join(dest, f.name));
    console.log(`\n✓ 已暂存 ${plan.length} 个文件`);
    console.log(`  下一步：scp -r ${dest}/* <ssh别名>:~/ai-video/data/artifacts/`);
    console.log('  （库内路径已按 basename 指向 data/artifacts/，文件到位即生效；无需再改库）');
  }
  db.close();
  process.exit(0);
}

let total = 0;

if (mode === 'rewrite') {
  for (const t of TEXT_TARGETS) {
    // 先归一化分隔符，再逐条前缀替换；WHERE 同时匹配两种写法
    let expr = normalizeSep ? `REPLACE(${t.column}, '\\', '/')` : t.column;
    const params = [];
    const where = [];
    for (const m of maps) {
      // 先在 WHERE 里试原样与 posix 两种写法，命中后再按 posix 前缀替换（expr 已归一化分隔符）
      where.push(`instr(COALESCE(${t.column}, ''), ?) > 0`, `instr(COALESCE(${t.column}, ''), ?) > 0`);
      if (normalizeSep) {
        expr = `REPLACE(${expr}, ?, ?)`;
        params.push(m.from, m.to);
      } else {
        expr = `REPLACE(${expr}, ?, ?)`;
        params.push(m.raw, m.to);
      }
    }
    const whereSql = where.join(' OR ');
    const whereParams = maps.flatMap((m) => [m.from, m.raw]);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${whereSql}`).get(...whereParams).n;
    total += n;
    console.log(`${String(n).padStart(5)} 行  ${t.table}.${t.column}`);
    if (n && !dryRun) {
      db.prepare(`UPDATE ${t.table} SET ${t.column} = ${expr} WHERE ${whereSql}`).run(...params, ...whereParams);
    }
  }
  for (const t of JSON_TARGETS) {
    const rows = db
      .prepare(`SELECT ${t.pk} AS id, ${t.column} AS v FROM ${t.table} WHERE ${t.column} IS NOT NULL`)
      .all();
    let hit = 0;
    const updates = [];
    for (const r of rows) {
      const { text, changed } = rewriteJsonStrings(String(r.v));
      if (!changed) continue;
      hit += 1;
      updates.push([text, r.id]);
    }
    total += hit;
    console.log(`${String(hit).padStart(5)} 行  ${t.table}.${t.column}（JSON 内路径字符串）`);
    if (!dryRun) {
      const stmt = db.prepare(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${t.pk} = ?`);
      for (const u of updates) stmt.run(...u);
    }
  }
} else {
  for (const t of TEXT_TARGETS) {
    if (t.heavy && !includeTasks) {
      console.log(` 跳过  ${t.table}.${t.column}（加 --include-tasks 才动；置空会触发历史归档补扫）`);
      continue;
    }
    const rows = db
      .prepare(`SELECT ${t.pk} AS id, ${t.column} AS v FROM ${t.table} WHERE ${t.column} IS NOT NULL`)
      .all();
    const updates = [];
    for (const r of rows) {
      const norm = normalizeSep ? posix(r.v) : String(r.v);
      if (fs.existsSync(norm)) {
        if (norm !== r.v) updates.push([norm, r.id]); // 文件在，只修分隔符
      } else {
        updates.push([null, r.id]); // 文件不在，置空（前端回退远端 URL）
      }
    }
    const nulled = updates.filter((u) => u[0] === null).length;
    total += updates.length;
    console.log(
      `${String(updates.length).padStart(5)} 行  ${t.table}.${t.column}（其中置空 ${nulled}，仅修分隔符 ${updates.length - nulled}）`,
    );
    if (!dryRun) {
      const stmt = db.prepare(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${t.pk} = ?`);
      for (const u of updates) stmt.run(...u);
    }
  }
  console.log(
    ' 提示  projects.bgm / settings.* 里的 local_path 本模式不动（bgm 失效会被渲染阶段自动重选自愈；角色库用远端 URL 即可）',
  );
}

if (!dryRun) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

/* ------------------------------ 复核 ------------------------------ */
function leftoverCount() {
  let n = 0;
  for (const t of TEXT_TARGETS) {
    const rows = db.prepare(`SELECT ${t.column} v FROM ${t.table} WHERE ${t.column} IS NOT NULL`).all();
    n += rows.filter((r) => WIN_ABS.test(String(r.v))).length;
  }
  const samples = [];
  for (const t of TEXT_TARGETS) {
    for (const r of db.prepare(`SELECT ${t.column} v FROM ${t.table} WHERE ${t.column} IS NOT NULL`).all()) {
      if (WIN_ABS.test(String(r.v)) && samples.length < 3) samples.push(String(r.v));
    }
  }
  return { n, samples };
}

if (!dryRun) {
  if (mode === 'rewrite') {
    const { n, samples } = leftoverCount();
    console.log(`\n复核：仍含 Windows 盘符路径的行 = ${n}`);
    for (const s of samples) console.log(`   ${s}`);
    if (n) console.log('   → 说明还有未被 --from 覆盖的前缀（用 --mode report 看分布，补 --from 再跑一次）');
  } else {
    console.log(
      '\n复核：clear-missing 只处理了上面列出的列；tasks（未开 --include-tasks）与 JSON 列保留原路径属预期。',
    );
  }
}
db.close();
console.log(dryRun ? `\n（dry-run）共涉及 ${total} 行；确认无误后重跑并加 --apply` : `\n✓ 已写入 ${total} 行`);
