'use strict';
/**
 * tools/series-new-episode.js —— 系列开集脚手架（v2.5）
 *
 * 把"建项目 → 从角色库导入角色 → 批量导入分镜 → 逐镜提交视频 → 逐镜配音"五步压成一条命令：
 *   node tools/series-new-episode.js <episode.json> [--no-submit] [--no-tts]
 *
 * episode.json 结构：
 * {
 *   "name": "幻灯屋 S1E03 夏の約束",
 *   "idea": "一句话创意…",
 *   "style": "风格锚（所有镜头逐字复制）",
 *   "aspect_ratio": "16:9",
 *   "seconds": "10",
 *   "characters": ["<角色库 id>", "…"],           // 可选：按序导入并定稿（<Picture N> 编号即此顺序）
 *   "voice": "<TTS 音色 id>",                      // 可选：逐镜配音用（省略则用平台默认）
 *   "shots": [
 *     {
 *       "title": "镜1",
 *       "video_prompt": "…（不含风格锚亦可，脚本会自动追加）",
 *       "seconds": "10",
 *       "narration": "中文脚本（≤秒数×4 字）",       // 字幕主行
 *       "tts_text": "日文配音文本（音拍 ≤ 秒数×7）", // 配音（与字幕不同则成片自动双语两行）
 *       "ref_image_ids_index": [0, 1],              // 本镜出场角色 = characters 的下标（省略=引用全部定稿角色图）
 *       "use_character_ref": 1
 *     }
 *   ]
 * }
 */
const { api, sleep } = require('./agnes-api');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node tools/series-new-episode.js <episode.json> [--no-submit] [--no-tts]');
  process.exit(1);
}

(async () => {
  const ep = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  for (const k of ['name', 'idea', 'style', 'shots']) {
    if (!ep[k]) throw new Error(`episode.json 缺少必填字段：${k}`);
  }

  // 1) 建项目
  const p = await api('POST', '/api/projects', {
    name: ep.name,
    idea: ep.idea,
    style: ep.style,
    aspect_ratio: ep.aspect_ratio || '16:9',
    seconds: ep.seconds || '10',
  });
  console.log(`✅ 项目 #${p.id}《${p.name}》`);

  // 2) 从角色库导入角色（<Picture N> 按 characters 顺序编号）
  let charImageIds = [];
  if (Array.isArray(ep.characters) && ep.characters.length) {
    const r = await api('POST', `/api/projects/${p.id}/characters/import`, {
      character_ids: ep.characters.slice(0, 5),
    });
    charImageIds = (r.imported || []).map((x) => x.image_id);
    console.log(`✅ 角色导入 ${charImageIds.length} 个：${(r.imported || []).map((x) => x.name).join('、')}`);
    if (r.skipped?.length) console.warn(`⚠️ 跳过：${r.skipped.map((s) => `${s.name}（${s.reason}）`).join('；')}`);
  }

  // 3) 批量导入分镜（ref_image_ids_index → 项目内角色图 id）
  const shots = ep.shots.map((s) => {
    const refs = Array.isArray(s.ref_image_ids_index)
      ? s.ref_image_ids_index.map((i) => charImageIds[i]).filter(Boolean)
      : undefined;
    return {
      title: s.title,
      video_prompt: String(s.video_prompt).includes(ep.style) ? s.video_prompt : `${s.video_prompt}${ep.style}`,
      seconds: s.seconds || ep.seconds || '10',
      narration: s.narration || null,
      use_character_ref: s.use_character_ref === undefined ? 1 : s.use_character_ref,
      ...(refs && refs.length ? { ref_image_ids: refs } : {}),
    };
  });
  const bulk = await api('POST', `/api/projects/${p.id}/shots/bulk`, { shots });
  console.log(`✅ 分镜导入 ${bulk.imported} 镜`);

  if (flags.has('--no-submit')) {
    console.log(`\nPROJECT_ID=${p.id}（已跳过视频提交；可在控制台继续）`);
    return;
  }

  // 4) 逐镜提交视频（submitter 按 1 次/分钟节流排队）
  const d = await api('GET', `/api/projects/${p.id}`);
  for (const s of d.shots.sort((a, b) => a.seq - b.seq)) {
    const t = await api('POST', `/api/projects/${p.id}/shots/${s.id}/videos`, {});
    console.log(`  视频任务 镜${s.seq} → #${t.id}（queued）`);
  }

  if (flags.has('--no-tts')) {
    console.log(`\nPROJECT_ID=${p.id}（已跳过配音）`);
    return;
  }

  // 5) 逐镜配音（tts_text 为日文/外语配音；narration 为字幕脚本 → 成片自动双语）
  for (const s of ep.shots) {
    if (!s.tts_text) continue;
    const shot = (await api('GET', `/api/projects/${p.id}`)).shots.find((x) => x.seq === ep.shots.indexOf(s) + 1);
    if (!shot) continue;
    try {
      const t = await api('POST', '/api/tts/generate', {
        text: s.tts_text,
        kind: 'shot',
        shot_id: shot.id,
        project_id: p.id,
        ...(ep.voice ? { voice: ep.voice } : {}),
      });
      console.log(`  配音 镜${shot.seq} → ${t.duration}s`);
    } catch (e) {
      console.warn(`  配音 镜${shot.seq} 失败：${e.message}`);
    }
  }

  console.log(`\n✅ 开集完成：PROJECT_ID=${p.id}`);
  console.log('下一步：等视频完成 → 选 BGM（POST /api/projects/:id/bgm）→ 渲染（POST /api/projects/:id/render）');
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
