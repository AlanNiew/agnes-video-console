'use strict';
/**
 * routes/characters.js —— v2.5 角色库（跨项目复用的角色资产）
 * 存储于 settings.character_library（JSON 数组，与 creation_templates / tts_voice_pool 同款 KV，无需新表）。
 * 能力：
 *   - 从项目角色图「收藏」入库（名 / 图 URL / 本地路径 / 提示词 / 服色锚 / 所属系列）
 *   - 列表 / 删除
 *   - 导入项目：把库中角色复制为项目的 project_images 记录并定稿（多角色追加语义，Flash 上限 5 张）
 */
const { settings, DEFAULT_SETTINGS, projects } = require('../db');
const { ApiError, ah } = require('../core/errors');
const { log } = require('../core/logger');
const { MAX_CHARACTERS } = require('../core/constants');

const KEY = 'character_library';
const MAX_NAME = 40;
const MAX_TEXT = 500;
const MAX_IMPORT = 5; // 与 Flash reference images 上限一致

function readAll() {
  try {
    const arr = JSON.parse(settings.get(KEY, DEFAULT_SETTINGS[KEY]));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function writeAll(arr) {
  settings.set(KEY, JSON.stringify(arr));
}

module.exports = function registerCharacterRoutes(app) {
  // 角色库列表
  app.get('/api/characters', (req, res) => res.json({ items: readAll() }));

  // 收藏入库：{name, image_id?, project_id?, remote_url?, local_path?, prompt?, wardrobe?, series?}
  app.post(
    '/api/characters',
    ah(async (req, res) => {
      const b = req.body || {};
      const name = String(b.name || '')
        .trim()
        .slice(0, MAX_NAME);
      if (!name) throw new ApiError(400, '角色名不能为空');
      let remote_url = String(b.remote_url || '').trim() || null;
      let local_path = String(b.local_path || '').trim() || null;
      let prompt =
        String(b.prompt || '')
          .trim()
          .slice(0, MAX_TEXT) || null;
      // 支持直接从项目角色图收藏（image_id + project_id）
      if (b.image_id !== undefined && b.image_id !== null) {
        const pid = Number(b.project_id);
        if (!projects.get(pid)) throw new ApiError(404, '项目不存在');
        const img = projects.images(pid).find((x) => x.id === Number(b.image_id));
        if (!img) throw new ApiError(404, '图片记录不存在（或不属于该项目）');
        remote_url = remote_url || img.remote_url;
        local_path = local_path || img.local_path;
        prompt = prompt || img.prompt;
      }
      if (!remote_url) throw new ApiError(400, '缺少图片（请提供 image_id 或 remote_url）');
      const all = readAll();
      if (all.length >= MAX_CHARACTERS) throw new ApiError(400, `角色库已达上限（${MAX_CHARACTERS}）`);
      const ch = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        remote_url,
        local_path,
        prompt,
        wardrobe:
          String(b.wardrobe || '')
            .trim()
            .slice(0, MAX_TEXT) || null, // 服色/外观文字锚（分镜提示词复用）
        series:
          String(b.series || '')
            .trim()
            .slice(0, MAX_NAME) || null,
        created_at: Date.now(),
      };
      all.unshift(ch);
      writeAll(all);
      log('info', `角色库 +1：${name}（共 ${all.length} 条）`);
      res.status(201).json(ch);
    }),
  );

  // 删除角色
  app.delete(
    '/api/characters/:id',
    ah(async (req, res) => {
      const all = readAll();
      const next = all.filter((c) => c.id !== req.params.id);
      if (next.length === all.length) throw new ApiError(404, '角色不存在');
      writeAll(next);
      res.json({ ok: true });
    }),
  );

  // 导入角色到项目：{character_ids: []} → 复制为 project_images（kind=character）并追加定稿
  app.post(
    '/api/projects/:id/characters/import',
    ah(async (req, res) => {
      const p = projects.get(req.params.id);
      if (!p) throw new ApiError(404, '项目不存在');
      const ids = req.body?.character_ids;
      if (!Array.isArray(ids) || !ids.length) throw new ApiError(400, 'character_ids 需为非空数组');
      if (ids.length > MAX_IMPORT) throw new ApiError(400, `单次最多导入 ${MAX_IMPORT} 个角色`);
      const lib = readAll();
      const picked = ids.map((id) => lib.find((c) => c.id === String(id))).filter(Boolean);
      if (!picked.length) throw new ApiError(404, '角色库中无匹配角色');
      const imported = [];
      const skipped = [];
      for (const ch of picked) {
        if (!ch.remote_url) {
          skipped.push({ name: ch.name, reason: '无图片' });
          continue;
        }
        // v2.5：导入前探测图 URL 可达性（平台输出 URL 可能过期；不可达则跳过并回报，避免"导入后提交视频才发现拉不到图"）
        let reachable = false;
        try {
          const probe = await fetch(ch.remote_url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            signal: AbortSignal.timeout(8000),
          });
          reachable = probe.ok || probe.status === 206;
        } catch {
          reachable = false;
        }
        if (!reachable) {
          skipped.push({ name: ch.name, reason: '图片 URL 不可达（可能已过期，请在原项目重新收藏）' });
          continue;
        }
        const imgId = projects.addImage({
          project_id: p.id,
          kind: 'character',
          prompt: ch.prompt,
          remote_url: ch.remote_url,
          local_path: ch.local_path,
          size: null,
          ratio: null,
          model: null,
        });
        projects.selectImage(imgId, 'character', p.id, { append: true });
        imported.push({ character_id: ch.id, name: ch.name, image_id: imgId });
      }
      if (!imported.length) {
        throw new ApiError(400, `所选角色均不可用：${skipped.map((s) => `${s.name}（${s.reason}）`).join('；')}`);
      }
      projects.update(p.id, { status: 'character_done' });
      log(
        'info',
        `项目 #${p.id} 从角色库导入 ${imported.length} 个角色${skipped.length ? `（跳过 ${skipped.length} 个）` : ''}`,
      );
      res.status(201).json({ ok: true, imported, skipped });
    }),
  );
};
