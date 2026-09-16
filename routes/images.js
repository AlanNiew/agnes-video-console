'use strict';
/**
 * routes/images.js —— 图片生成（文生图 / 图生图，多张候选）（v1.9.1 拆分自 server.js）
 */
const { settings, DEFAULT_SETTINGS, projects, tasks } = require('../db');
const agnes = require('../clients/agnes');
const { downloadArtifact } = require('../lib/artifacts');
const { log } = require('../core/logger');
const { IMAGE_MODEL, providerOf } = require('../core/constants');
const { ApiError, ah, upstreamError } = require('../core/errors');
const { buildImagePayload, safeUrl } = require('../services/payloads');

module.exports = function registerImageRoutes(app) {
  // P1：图片生成异步任务入口（入队即返回，由 image-worker 后台执行；
  // 产物统一进任务中心列表/详情，可重试；不挂项目时结果仅留在任务记录中）
  app.post(
    '/api/images/tasks',
    ah(async (req, res) => {
      const { payload, prompt, size, ratio, model } = buildImagePayload(req.body);
      const b = req.body || {};
      const count = [1, 2, 3, 4].includes(Number(b.count)) ? Number(b.count) : 1;
      const imageKind = ['character', 'scene'].includes(b.kind) ? b.kind : 'character';
      let projectId = null;
      if (b.project_id !== undefined && b.project_id !== null && b.project_id !== '') {
        projectId = Number(b.project_id);
        if (!projects.get(projectId)) throw new ApiError(404, '项目不存在');
      }
      // 即梦图片走本地 CLI（凭证为 OAuth 登录态，由 CLI 保管），故不要求配置 api_key
      const isDreamina = providerOf(model) === 'dreamina';
      if (!isDreamina) {
        const apiKey = settings.get('api_key', '');
        if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
      }
      const id = tasks.insert({
        kind: 'image',
        status: 'queued',
        mode: 'text',
        model, // 必须原样入队：即梦模型若被硬编码的 IMAGE_MODEL 覆盖，provider 分流即失效
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
      const { payload, prompt, size, ratio, model } = buildImagePayload(req.body);
      const b = req.body || {};
      const kind = ['character', 'scene'].includes(b.kind) ? b.kind : 'character';
      const count = [1, 2, 3, 4].includes(Number(b.count)) ? Number(b.count) : 1;
      if (b.project_id !== undefined && !projects.get(b.project_id)) throw new ApiError(404, '项目不存在');
      // 即梦图片是异步任务（submit_id + query_result 轮询），本接口为同步等待语义，不适用
      if (providerOf(model) === 'dreamina') {
        throw new ApiError(400, '即梦图片为异步任务，请改用 POST /api/images/tasks（本同步接口仅支持 Agnes）');
      }
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
        const bad = settled.find((s) => s.status === 'rejected') || settled[0];
        if (bad.status === 'rejected') {
          log('error', `图片生成网络异常: ${bad.reason?.message}`);
          throw new ApiError(502, '图片生成网络异常：请检查网络连接与「设置」中的上游地址');
        }
        const v = bad.value;
        throw upstreamError(v.status, v.data?.error?.message, '图片生成');
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
            // v2.5 多角色：仅在"尚无定稿图"时自动定稿首张；后续角色图需手动定稿（否则历史定稿图会在提交时累积注入）
            if (!projects.selectedImage(b.project_id, kind)) {
              projects.selectImage(imgId, kind, b.project_id);
            }
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
