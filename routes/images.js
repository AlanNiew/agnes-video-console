'use strict';
/**
 * routes/images.js —— 图片生成（文生图 / 图生图，多张候选）（v1.9.1 拆分自 server.js）
 */
const { settings, DEFAULT_SETTINGS, projects, tasks } = require('../db');
const agnes = require('../agnes');
const { downloadArtifact } = require('../artifacts');
const { log } = require('../logger');
const { IMAGE_MODEL } = require('../constants');
const { ApiError, ah } = require('../errors');
const { buildImagePayload, safeUrl } = require('../services/payloads');

module.exports = function registerImageRoutes(app) {
  // P1：图片生成异步任务入口（入队即返回，由 image-worker 后台执行；
  // 产物统一进任务中心列表/详情，可重试；不挂项目时结果仅留在任务记录中）
  app.post(
    '/api/images/tasks',
    ah(async (req, res) => {
      const { payload, prompt, size, ratio } = buildImagePayload(req.body);
      const b = req.body || {};
      const count = [1, 2, 3, 4].includes(Number(b.count)) ? Number(b.count) : 1;
      const imageKind = ['character', 'scene'].includes(b.kind) ? b.kind : 'character';
      let projectId = null;
      if (b.project_id !== undefined && b.project_id !== null && b.project_id !== '') {
        projectId = Number(b.project_id);
        if (!projects.get(projectId)) throw new ApiError(404, '项目不存在');
      }
      const apiKey = settings.get('api_key', '');
      if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
      const id = tasks.insert({
        kind: 'image',
        status: 'queued',
        mode: 'text',
        model: IMAGE_MODEL,
        prompt,
        size,
        aspect_ratio: ratio || '1:1',
        request_json: { ...payload, count, image_kind: projectId ? imageKind : null },
        project_id: projectId,
      });
      log(
        'info',
        `图片任务 #${id} 已入队（${count} 张 · ${size}${ratio ? ` · ${ratio}` : ''}${projectId ? ` · 项目 #${projectId}` : ' · 独立创作'}），后台工作器将执行生成`,
      );
      res.status(201).json(tasks.get(id));
    }),
  );

  // 图片生成（文生图 / 图生图，同步；count 支持 1/2/4 张并行，供挑选种子图）
  app.post(
    '/api/images/generate',
    ah(async (req, res) => {
      const { payload, prompt, size, ratio } = buildImagePayload(req.body);
      const b = req.body || {};
      const kind = ['character', 'scene'].includes(b.kind) ? b.kind : 'character';
      const count = [1, 2, 3, 4].includes(Number(b.count)) ? Number(b.count) : 1;
      if (b.project_id !== undefined && !projects.get(b.project_id)) throw new ApiError(404, '项目不存在');
      const apiKey = settings.get('api_key', '');
      if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
      // 并行生成 count 张；多张时部分失败不阻塞成功者
      const settled = await Promise.allSettled(
        Array.from({ length: count }, () =>
          agnes.generateImage({
            apiKey,
            baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
            payload,
          }),
        ),
      );
      const remoteUrls = [];
      for (const s of settled) {
        if (s.status !== 'fulfilled' || !s.value.ok) continue;
        const u = safeUrl(s.value.data?.data?.[0]?.url);
        if (u) remoteUrls.push(u);
      }
      if (!remoteUrls.length) {
        const detail =
          settled.find((s) => s.status === 'rejected')?.reason?.message ||
          (settled[0].status === 'fulfilled'
            ? settled[0].value.data?.error?.message || settled[0].value.raw || `HTTP ${settled[0].value.status}`
            : '未知错误');
        throw new ApiError(502, `图片生成失败：${String(detail).slice(0, 300)}`);
      }
      // 逐张落库（含本地备份下载），第一张成功图自动定稿
      const results = [];
      let first = null;
      for (let i = 0; i < remoteUrls.length; i++) {
        const remoteUrl = remoteUrls[i];
        const backup = await downloadArtifact(remoteUrl);
        let image = null;
        if (b.project_id) {
          const imgId = projects.addImage({
            project_id: b.project_id,
            kind,
            prompt,
            remote_url: remoteUrl,
            local_path: backup?.local_path || null,
            size,
            ratio,
            model: IMAGE_MODEL,
          });
          if (i === 0) {
            projects.selectImage(imgId, kind, b.project_id);
            if (kind === 'character') projects.update(b.project_id, { status: 'character_done' });
          }
          image = projects.images(b.project_id).find((x) => x.id === imgId) || null;
        }
        const item = { remote_url: remoteUrl, local_url: backup?.local_url || null, size, ratio, image };
        results.push(item);
        if (i === 0) first = item;
      }
      const failed = count - remoteUrls.length;
      log(
        'info',
        `图片生成：成功 ${remoteUrls.length}/${count} 张${b.project_id ? `（项目 #${b.project_id} ${kind === 'character' ? '角色图' : '场景图'}）` : ''}${failed ? `，失败 ${failed} 张` : ''}`,
      );
      res.json({
        remote_url: first.remote_url,
        local_url: first.local_url,
        size,
        ratio,
        image: first.image,
        results,
        failed,
      });
    }),
  );

  // 删除项目图片记录
  app.delete('/api/images/:id', (req, res) => {
    if (!projects.removeImage(req.params.id)) throw new ApiError(404, '图片记录不存在');
    res.json({ ok: true });
  });
};
