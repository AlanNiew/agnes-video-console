'use strict';
/**
 * routes/projects.js —— 创作工作台域：项目 CRUD / 文案版本 / 图片定稿 / 镜头工作副本 /
 * 分镜版本选用 / 视频任务提交入口 / 重拍与定稿（v1.9.1 拆分自 server.js）
 */
const { projects } = require('../db');
const { createPipelineService } = require('../services/pipeline');
const { log } = require('../core/logger');
const autoPipeline = require('../workers/auto');
const {
  ASPECT_RATIOS,
  SECONDS_OK,
  PROJECT_STATUSES,
  MAX_SHOTS,
  MAX_TEXT_LEN,
  MAX_BULK_SHOTS,
  SHOT_MODES,
} = require('../core/constants');
const { ApiError, ah } = require('../core/errors');
const { buildPayload } = require('../services/payloads');
const { submitTask } = require('../services/task-queue');
const { normalizeStoryboardShots } = require('../services/prompts');

/* 流水线服务层（镜头/项目视频提交编排，M2） */
const pipeline = createPipelineService({ projects, buildPayload, submitTask, ApiError, log });

/** 项目任务行的展示标注：同镜头已有 completed 任务时，更早的 failed/submit_error 记为
 * superseded（v1.3 起此规则原在 db.js 数据层；M3 上移到 API 聚合层——数据层只做纯查询） */
function annotateSuperseded(rows) {
  const okShots = new Set(rows.filter((t) => t.status === 'completed' && t.shot_id).map((t) => t.shot_id));
  for (const t of rows) {
    if (t.shot_id && okShots.has(t.shot_id) && (t.status === 'failed' || t.status === 'submit_error')) {
      t.superseded = true;
    }
  }
  return rows;
}

/** v2.2.2：旁白字数上限 = 镜头秒数 × 4（与 services/prompts.js clampNarration 同一规则，供接口层 400 拦截） */
function narrationCap(seconds) {
  return Math.max(8, Math.floor((Number(seconds) || 5) * 4));
}

module.exports = function registerProjectRoutes(app) {
  /* ---------- P3：全自动成片（启动 / 状态 / 停止） ---------- */
  // 启动：从文案到成片全自动推进（失败自动重试，卡住停在人工介入点）
  app.post(
    '/api/projects/:id/auto',
    ah(async (req, res) => {
      const r = autoPipeline.launch(Number(req.params.id));
      if (!r.ok) throw new ApiError(r.code, r.message);
      res.status(202).json({ ok: true, auto_state: r.state });
    }),
  );
  // 状态（前端进度时间线数据源）
  app.get('/api/projects/:id/auto', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    res.json({ auto_state: p.auto_state, stage_meta: autoPipeline.STAGE_META });
  });
  // 停止（保留已产出内容）
  app.post(
    '/api/projects/:id/auto/stop',
    ah(async (req, res) => {
      const r = autoPipeline.stopProject(Number(req.params.id));
      if (!r.ok) throw new ApiError(r.code, r.message);
      res.json({ ok: true, auto_state: r.state });
    }),
  );

  app.post('/api/projects', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw new ApiError(400, '项目名称不能为空');
    if (b.aspect_ratio && !ASPECT_RATIOS.includes(b.aspect_ratio))
      throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
    if (b.seconds && !SECONDS_OK.includes(String(b.seconds))) throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
    const id = projects.insert({
      name,
      idea: b.idea,
      style: b.style,
      aspect_ratio: b.aspect_ratio,
      seconds: b.seconds,
    });
    res.status(201).json(projects.get(id));
  });

  app.get('/api/projects', (req, res) => res.json({ items: projects.list() }));

  app.get('/api/projects/:id', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    res.json({
      project: p,
      texts: projects.texts(p.id),
      images: projects.images(p.id),
      shots: projects.shots(p.id),
      tasks: annotateSuperseded(projects.tasks(p.id)),
      tts: projects.tts(p.id), // TTS 配音记录
    });
  });

  app.patch('/api/projects/:id', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const b = req.body || {};
    if (b.name !== undefined) {
      const n = String(b.name).trim();
      if (!n) throw new ApiError(400, '项目名称不能为空');
      b.name = n;
    }
    if (b.status !== undefined && !PROJECT_STATUSES.includes(b.status)) {
      throw new ApiError(400, `status 仅支持 ${PROJECT_STATUSES.join('/')}`);
    }
    if (b.aspect_ratio !== undefined && b.aspect_ratio !== null && !ASPECT_RATIOS.includes(b.aspect_ratio))
      throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
    if (b.seconds !== undefined && b.seconds !== null && !SECONDS_OK.includes(String(b.seconds)))
      throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
    if (b.idea !== undefined && b.idea !== null && String(b.idea).length > MAX_TEXT_LEN)
      throw new ApiError(400, `idea 长度需 ≤ ${MAX_TEXT_LEN}`);
    if (b.style !== undefined && b.style !== null) b.style = String(b.style).trim().slice(0, 200) || null;
    projects.update(p.id, {
      name: b.name,
      idea: b.idea,
      style: b.style,
      aspect_ratio: b.aspect_ratio,
      seconds: b.seconds,
      status: b.status,
    });
    res.json(projects.get(p.id));
  });

  app.delete('/api/projects/:id', (req, res) => {
    if (!projects.remove(req.params.id)) throw new ApiError(404, '项目不存在');
    res.json({ ok: true });
  });

  // v2.5 制作 checklist（开拍/交付自检）：逐项状态 + 就绪度百分比
  app.get('/api/projects/:id/checklist', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const shots = projects.shots(p.id);
    const chars = projects.images(p.id).filter((x) => x.kind === 'character' && x.selected);
    const tasks = projects.tasks(p.id);
    const tts = projects.tts(p.id);
    const items = [];
    const add = (key, label, ok, detail = '') => items.push({ key, label, ok: Boolean(ok), detail });
    const latestTts = (sid) =>
      tts
        .filter((x) => x.kind === 'shot' && x.shot_id === sid && x.local_path && !x.error_message)
        .sort((a, b) => b.id - a.id)[0];
    add('idea', '创意已填写', !!p.idea, p.idea ? '' : '一句话创意决定成片上限');
    add('style', '风格锚已填写', !!p.style, p.style ? '' : '所有镜头需逐字复制同一风格锚（跨镜一致性）');
    add(
      'characters',
      '角色定稿图就绪',
      chars.length > 0,
      chars.length ? `${chars.length} 个角色` : '第③步定稿角色图（纯空镜项目可忽略）',
    );
    add('shots', '分镜已就绪（≥2 镜）', shots.length >= 2, `${shots.length} 镜`);
    const noNarr = shots.filter((s) => !s.narration);
    add(
      'narration',
      '每镜有旁白',
      shots.length > 0 && noNarr.length === 0,
      noNarr.length ? `${noNarr.length} 镜缺旁白` : '',
    );
    const doneShots = shots.filter((s) => tasks.some((t) => t.shot_id === s.id && t.status === 'completed'));
    add(
      'videos',
      '镜头视频完成',
      shots.length > 0 && doneShots.length === shots.length,
      `${doneShots.length}/${shots.length} 镜`,
    );
    const ttsShots = shots.filter((s) => latestTts(s.id));
    add(
      'tts',
      '逐镜配音完成',
      shots.length > 0 && ttsShots.length === shots.length,
      `${ttsShots.length}/${shots.length} 镜`,
    );
    const over = shots.filter((s) => {
      const t = latestTts(s.id);
      if (!t || !t.duration) return false;
      const off = (t.offset_ms != null ? t.offset_ms : 500) / 1000;
      return t.duration + off > Number(s.seconds || p.seconds || 5) * 1.03;
    });
    add(
      'timing',
      '配音时长未超镜长',
      over.length === 0,
      over.length ? `${over.length} 镜可能被截断（${over.map((s) => '镜' + s.seq).join('、')}）` : '',
    );
    add('bgm', 'BGM 已选择', !!p.bgm?.song_id, p.bgm?.name ? `《${p.bgm.name}》` : '可选（第⑥步选曲）');
    const ready = items.filter((i) => i.ok).length;
    res.json({ ok: true, items, ready, total: items.length, ready_pct: Math.round((ready / items.length) * 100) });
  });

  // 选定文案版本（同一 kind 只有一条 selected）
  app.post('/api/projects/:id/select-text', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const textId = Number(req.body?.text_id);
    const target = projects.texts(p.id).find((t) => t.id === textId);
    if (!target) throw new ApiError(404, '文案记录不存在');
    projects.selectText(textId, target.kind, p.id);
    res.json({ ok: true });
  });

  // 编辑文案版本内容（手动微调；校验文案归属当前项目，防跨项目越权编辑）
  app.patch('/api/projects/:id/texts/:textId', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const content = String(req.body?.content ?? '').trim();
    if (!content) throw new ApiError(400, '内容不能为空');
    if (content.length > MAX_TEXT_LEN) throw new ApiError(400, `内容长度需 ≤ ${MAX_TEXT_LEN}`);
    const target = projects.texts(p.id).find((t) => t.id === Number(req.params.textId));
    if (!target) throw new ApiError(404, '文案记录不存在');
    if (!projects.updateText(target.id, content)) throw new ApiError(404, '文案记录不存在');
    res.json({ ok: true });
  });

  // 选定图片定稿（v2.5：kind='character' 允许多张并存 = 多角色；其他 kind 同 kind 唯一）
  app.post('/api/projects/:id/select-image', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const imgId = Number(req.body?.image_id);
    const target = projects.images(p.id).find((x) => x.id === imgId);
    if (!target) throw new ApiError(404, '图片记录不存在');
    // selected 默认 true；传 false 可取消该图定稿（不删除记录）；append=true 追加（多角色）而非替换
    const selected = req.body?.selected === undefined ? true : Boolean(req.body.selected);
    const append = Boolean(req.body?.append);
    projects.selectImage(imgId, target.kind, p.id, { selected, append });
    res.json({ ok: true });
  });

  // 选用历史 storyboard 版本 → 重建镜头工作副本（选中该版本 + 整体替换 shots）
  app.post('/api/projects/:id/storyboard/apply', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const textId = Number(req.body?.text_id);
    const target = projects.texts(p.id).find((t) => t.id === textId && t.kind === 'storyboard');
    if (!target) throw new ApiError(404, 'storyboard 版本不存在');
    let parsedContent;
    try {
      parsedContent = JSON.parse(target.content || '{}');
    } catch {
      throw new ApiError(400, '该 storyboard 版本内容不是合法 JSON');
    }
    const shots = normalizeStoryboardShots(parsedContent.shots, p.seconds || '5');
    if (!shots.length) throw new ApiError(400, '该 storyboard 版本没有有效镜头');
    projects.selectText(target.id, 'storyboard', p.id);
    projects.replaceShots(p.id, shots);
    log('info', `项目 #${p.id} 选用 storyboard 版本 #${target.id}（${shots.length} 个镜头）`);
    res.json({ ok: true, shots: projects.shots(p.id) });
  });

  // 手动添加镜头（追加到末尾）
  app.post('/api/projects/:id/shots', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const existing = projects.shots(p.id);
    if (existing.length >= MAX_SHOTS) throw new ApiError(400, `每个项目最多 ${MAX_SHOTS} 个镜头`);
    const b = req.body || {};
    const vp = String(b.video_prompt || '').trim();
    if (!vp) throw new ApiError(400, 'video_prompt 不能为空');
    if (vp.length > MAX_TEXT_LEN) throw new ApiError(400, `video_prompt 长度需 ≤ ${MAX_TEXT_LEN}`);
    if (b.seconds !== undefined && b.seconds !== null && !SECONDS_OK.includes(String(b.seconds))) {
      throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
    }
    const mode = SHOT_MODES.includes(b.mode) ? b.mode : 'reference';
    // v2.2.2：手动录入旁白同样受「秒数×4」限长约束（否则渲染时被镜头时长截断，说一半）
    let narration;
    if (b.narration !== undefined && b.narration !== null) {
      narration = String(b.narration).trim() || null;
      if (narration) {
        const effSec = b.seconds !== undefined && b.seconds !== null ? String(b.seconds) : '5';
        const cap = narrationCap(effSec);
        if (narration.length > cap) {
          throw new ApiError(400, `旁白过长：该镜头 ${effSec} 秒最多 ${cap} 字（含标点），请删减后保存`);
        }
      }
    }
    const maxSeq = existing.reduce((m, s) => Math.max(m, s.seq), 0);
    const id = projects.addShot({
      project_id: p.id,
      seq: maxSeq + 1,
      title:
        String(b.title || '')
          .trim()
          .slice(0, 100) || null,
      video_prompt: vp,
      seconds: b.seconds || null,
      mode,
      narration,
      use_character_ref: b.use_character_ref,
      ref_image_ids: b.ref_image_ids, // v2.5 多角色：本镜出场角色图 id 数组（省略 = 引用全部定稿角色图）
    });
    res.status(201).json(projects.shots(p.id).find((s) => s.id === id));
  });

  // v2.5 分镜批量导入：一次建多个镜头（事务）——{shots:[{title?,video_prompt,seconds?,narration?,use_character_ref?,ref_image_ids?}], mode?(append|replace)}
  app.post('/api/projects/:id/shots/bulk', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const b = req.body || {};
    const list = b.shots;
    if (!Array.isArray(list) || !list.length) throw new ApiError(400, 'shots 需为非空数组');
    if (list.length > MAX_BULK_SHOTS) throw new ApiError(400, `单次最多导入 ${MAX_BULK_SHOTS} 个镜头`);
    const mode = b.mode === 'replace' ? 'replace' : 'append';
    const existing = projects.shots(p.id);
    if (mode === 'append' && existing.length + list.length > MAX_SHOTS) {
      throw new ApiError(400, `镜头总数将超过上限（${MAX_SHOTS}）：现有 ${existing.length} + 新增 ${list.length}`);
    }
    // 校验（批量导入一次性拦下所有问题，避免"导入一半才发现"）
    const charIds = new Set(
      projects
        .images(p.id)
        .filter((x) => x.kind === 'character' && x.selected)
        .map((x) => x.id),
    );
    const errs = [];
    list.forEach((s, i) => {
      const idx = i + 1;
      if (!String(s.video_prompt || '').trim()) errs.push(`第 ${idx} 镜：video_prompt 不能为空`);
      if (s.seconds !== undefined && s.seconds !== null && !SECONDS_OK.includes(String(s.seconds))) {
        errs.push(`第 ${idx} 镜：seconds 仅支持 4–12`);
      }
      const effSec = s.seconds !== undefined && s.seconds !== null ? String(s.seconds) : p.seconds || '5';
      const nar = s.narration === undefined || s.narration === null ? '' : String(s.narration).trim();
      if (nar) {
        const cap = Math.max(8, Math.floor((Number(effSec) || 5) * 4));
        if (nar.length > cap) errs.push(`第 ${idx} 镜：旁白 ${nar.length} 字超上限 ${cap} 字（${effSec} 秒）`);
      }
      if (Array.isArray(s.ref_image_ids)) {
        for (const id of s.ref_image_ids) {
          if (!charIds.has(Number(id))) errs.push(`第 ${idx} 镜：ref_image_ids 含非本项目定稿角色图 #${id}`);
        }
      }
    });
    if (errs.length) {
      throw new ApiError(
        400,
        `分镜校验未通过：${errs.slice(0, 5).join('；')}${errs.length > 5 ? `（等 ${errs.length} 项）` : ''}`,
      );
    }
    const created = projects.bulkAddShots(p.id, list, mode);
    log('info', `项目 #${p.id} 批量导入 ${created.length} 个镜头（${mode}）`);
    res.status(201).json({ ok: true, imported: created.length, shots: projects.shots(p.id) });
  });

  // 编辑镜头（标题/提示词/时长/旁白/引用开关；归属校验防跨项目越权）
  app.patch('/api/projects/:id/shots/:shotId', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
    if (!shot) throw new ApiError(404, '镜头不存在');
    const b = req.body || {};
    const patch = {};
    if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 100) || null;
    if (b.video_prompt !== undefined) {
      const vp = String(b.video_prompt).trim();
      if (!vp) throw new ApiError(400, 'video_prompt 不能为空');
      if (vp.length > MAX_TEXT_LEN) throw new ApiError(400, `video_prompt 长度需 ≤ ${MAX_TEXT_LEN}`);
      patch.video_prompt = vp;
    }
    if (b.seconds !== undefined) {
      if (b.seconds !== null && !SECONDS_OK.includes(String(b.seconds)))
        throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
      patch.seconds = b.seconds;
    }
    // v1.3：旁白文案与角色引用开关（v2.2.2 按镜头秒数×4 校验，避免成片配音被截断）
    if (b.narration !== undefined) {
      if (b.narration === null) {
        patch.narration = null;
      } else {
        const nar = String(b.narration).trim() || null;
        if (nar) {
          const effSec = b.seconds !== undefined && b.seconds !== null ? String(b.seconds) : shot.seconds || '5';
          const cap = narrationCap(effSec);
          if (nar.length > cap) {
            throw new ApiError(400, `旁白过长：该镜头 ${effSec} 秒最多 ${cap} 字（含标点），请删减后保存`);
          }
        }
        patch.narration = nar;
      }
    }
    if (b.use_character_ref !== undefined) {
      patch.use_character_ref = b.use_character_ref ? 1 : 0;
    }
    // v2.5 多角色：本镜出场的角色图 id（null = 引用全部定稿角色图；数组上限 5 张）
    if (b.ref_image_ids !== undefined) {
      if (b.ref_image_ids === null) {
        patch.ref_image_ids = null;
      } else if (Array.isArray(b.ref_image_ids)) {
        patch.ref_image_ids = b.ref_image_ids
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 5);
      } else {
        throw new ApiError(400, 'ref_image_ids 需为角色图 id 数组（或 null）');
      }
    }
    projects.updateShot(shot.id, patch);
    res.json(projects.shots(p.id).find((s) => s.id === shot.id));
  });

  // 删除镜头（关联视频任务保留，shot_id 成为历史引用）
  // v2.5.1 预览本镜「实际会发给上游」的提示词（含自动注入的风格锚/角色前缀）——排查风格漂移
  app.get('/api/projects/:id/shots/:shotId/final-prompt', (req, res) => {
    res.json(pipeline.previewVideoPrompt({ projectId: req.params.id, shotId: req.params.shotId }));
  });

  app.delete('/api/projects/:id/shots/:shotId', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
    if (!shot) throw new ApiError(404, '镜头不存在');
    projects.removeShot(shot.id);
    res.json({ ok: true });
  });

  // 镜头排序：ids 按新顺序给出，必须与现有镜头一一对应（不重不漏）
  app.post('/api/projects/:id/shots/reorder', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) throw new ApiError(400, 'ids 必须是非空数组');
    const current = projects.shots(p.id);
    const idSet = new Set(current.map((s) => s.id));
    const reqIds = ids.map(Number);
    if (
      reqIds.length !== current.length ||
      reqIds.some((id) => !idSet.has(id)) ||
      new Set(reqIds).size !== reqIds.length
    ) {
      throw new ApiError(400, 'ids 必须与项目现有镜头一一对应（不重不漏）');
    }
    projects.reorderShots(p.id, reqIds);
    res.json({ ok: true, shots: projects.shots(p.id) });
  });

  // 单镜头提交视频任务（M2 主入口；复用 pipeline 服务层组装与溯源）
  app.post(
    '/api/projects/:id/shots/:shotId/videos',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
      if (!shot) throw new ApiError(404, '镜头不存在');
      const b = req.body || {};
      const task = await pipeline.submitVideoTask({
        projectId: p.id,
        shot, // v1.3：传入镜头行，pipeline 据此尊重 use_character_ref / mode
        prompt: shot.video_prompt,
        seconds: b.seconds || shot.seconds,
        aspectRatio: b.aspect_ratio,
        shotId: shot.id,
        model: b.model || null, // v2.6.6：可选逐镜模型覆盖（如切 agnes-video-v2.0 绕开 flash 队列）
      });
      res.status(201).json(task);
    }),
  );

  // v1.7 镜头重拍：一次提交 N 条候选任务（提交队列自动按分钟节流；完成后在下方选定 take）
  app.post(
    '/api/projects/:id/shots/:shotId/retakes',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
      if (!shot) throw new ApiError(404, '镜头不存在');
      const b = req.body || {};
      // v2.2.2：越界数量直接 400 提示范围，不再静默砍到 3（用户以为提交了 5 条实际只有 3 条）
      const rawCount = b.count === undefined || b.count === null || b.count === '' ? 1 : Number(b.count);
      if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 3) {
        throw new ApiError(400, '重拍数量 count 需为 1–3 之间的整数');
      }
      const count = rawCount;
      const created = [];
      for (let i = 0; i < count; i++) {
        const task = await pipeline.submitVideoTask({
          projectId: p.id,
          shot,
          prompt: shot.video_prompt,
          seconds: b.seconds || shot.seconds,
          aspectRatio: b.aspect_ratio,
          shotId: shot.id,
          model: b.model || null, // v2.6.6：重拍同样支持逐镜模型覆盖
        });
        created.push({ id: task.id, status: task.status });
      }
      log('info', `项目 #${p.id} 镜头 #${shot.id}（seq ${shot.seq}）重拍 ${created.length} 条候选`);
      res.status(201).json({ ok: true, retakes: created });
    }),
  );

  // v1.7 镜头选定定稿 take：{task_id}（须为该镜头已完成且有产物的任务）；task_id=null 恢复自动模式
  app.post('/api/projects/:id/shots/:shotId/select-take', (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) throw new ApiError(404, '项目不存在');
    const shot = projects.shots(p.id).find((s) => s.id === Number(req.params.shotId));
    if (!shot) throw new ApiError(404, '镜头不存在');
    const raw = req.body?.task_id;
    if (raw === null || raw === undefined || raw === '') {
      projects.setShotTake(shot.id, null);
      log('info', `镜头 #${shot.id} 恢复自动模式（渲染用最新完成条）`);
      return res.json({ ok: true, shot: projects.shots(p.id).find((s) => s.id === shot.id) });
    }
    const taskId = Number(raw);
    const task = projects.tasks(p.id).find((t) => t.id === taskId && t.shot_id === shot.id);
    if (!task) throw new ApiError(404, '任务不存在（或不属于该镜头）');
    if (task.status !== 'completed' || (!task.video_local_path && !task.metadata_url)) {
      throw new ApiError(400, '只有已完成且有产物的任务才能定为定稿 take');
    }
    projects.setShotTake(shot.id, taskId);
    log('info', `镜头 #${shot.id}（seq ${shot.seq}）选定定稿 take：任务 #${taskId}`);
    res.json({ ok: true, shot: projects.shots(p.id).find((s) => s.id === shot.id) });
  });

  // 从项目发起视频任务（旧入口，保留原语义）：角色定稿图 + 选定分镜提示词 → 2.5-flash reference 模式。
  // 组装与溯源逻辑在 pipeline.js 服务层；M2 起新流程走 /api/projects/:id/shots/:shotId/videos
  app.post(
    '/api/projects/:id/videos',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      const b = req.body || {};
      let prompt = String(b.prompt || '').trim();
      if (!prompt) {
        const selectedVideo = projects.selectedText(p.id, 'video_prompt');
        prompt = selectedVideo?.content || '';
      }
      if (!prompt) {
        const latest = projects.texts(p.id).find((t) => t.kind === 'video_prompt');
        prompt = latest?.content || '';
      }
      const task = await pipeline.submitVideoTask({
        projectId: p.id,
        prompt,
        seconds: b.seconds,
        aspectRatio: b.aspect_ratio,
      });
      res.status(201).json(task);
    }),
  );
};
