'use strict';
/**
 * routes/tts.js —— TTS 配音（Fish Audio）：音色清单 / 备选池 / 声音广场 / 合成 / 选用 / 绑定 / 删除
 * （v1.9.1 拆分自 server.js）
 */
const fs = require('node:fs');
const path = require('node:path');
const { settings, projects } = require('../db');
const fishTts = require('../fish-tts');
const { ARTIFACTS_DIR } = require('../artifacts');
const { log } = require('../logger');
const { TTS_VOICES, TTS_MODELS, TTS_MAX_TEXT, MARKET_SORTS } = require('../constants');
const { probeDuration } = require('../config');
const { ApiError, ah } = require('../errors');
const { getVoicePool, setVoicePool } = require('../services/voice-pool');

module.exports = function registerTtsRoutes(app) {
  // 音色清单（v1.9：默认预设 + 声音广场备选池合并）
  app.get('/api/tts/voices', (req, res) => {
    const pool = getVoicePool().map((v) => ({
      id: v.id,
      title: '⭐ ' + v.title,
      desc: `声音广场 · ${v.author || '社区'} · ♥${v.like_count || 0} · 用量${v.task_count || 0}`,
    }));
    res.json({ voices: [...TTS_VOICES, ...pool], models: TTS_MODELS, pool });
  });

  // v1.9 备选池读写
  app.get('/api/tts/pool', (req, res) => res.json({ items: getVoicePool() }));
  app.post('/api/tts/pool', (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').trim();
    if (!/^[0-9a-f]{16,}$/i.test(id)) throw new ApiError(400, 'id 需为音色模型 id（32 位十六进制）');
    const pool = getVoicePool();
    if (pool.some((v) => v.id === id)) return res.json({ ok: true, pool, dedup: true });
    pool.push({
      id,
      title:
        String(b.title || '')
          .trim()
          .slice(0, 80) || '未命名音色',
      author:
        String(b.author || '')
          .trim()
          .slice(0, 60) || '',
      like_count: Number(b.like_count) || 0,
      task_count: Number(b.task_count) || 0,
      tags: Array.isArray(b.tags) ? b.tags.slice(0, 8).map((t) => String(t).slice(0, 20)) : [],
      added_at: Date.now(),
    });
    setVoicePool(pool);
    log('info', `音色备选池 +1：${pool[pool.length - 1].title}（共 ${pool.length} 条）`);
    res.json({ ok: true, pool });
  });
  app.delete('/api/tts/pool/:id', (req, res) => {
    const pool = getVoicePool();
    const next = pool.filter((v) => v.id !== String(req.params.id));
    if (next.length === pool.length) throw new ApiError(404, '备选池中无此音色');
    setVoicePool(next);
    res.json({ ok: true, pool: next });
  });

  // v1.9 声音广场：浏览社区音色（代理 fish.audio /model/web，需 fish_web_token）
  app.get(
    '/api/tts/market',
    ah(async (req, res) => {
      const token = settings.get('fish_web_token', '');
      if (!token) throw new ApiError(400, '尚未配置声音广场 Token（fish_web_token）');
      const sortBy = MARKET_SORTS.includes(String(req.query.sort_by)) ? String(req.query.sort_by) : 'trending';
      const language = String(req.query.language || 'zh');
      let tags = req.query.tag || [];
      if (!Array.isArray(tags)) tags = [tags];
      tags = tags
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 4);
      const r = await fishTts.listWebModels({
        token,
        sortBy,
        language,
        tags,
        pageNumber: Number(req.query.page_number) || 1,
        pageSize: Math.min(Math.max(Number(req.query.page_size) || 12, 1), 30),
      });
      if (!r.ok)
        throw new ApiError(
          r.status >= 400 && r.status < 500 ? 400 : 502,
          `声音广场请求失败（${r.status}）：${r.error}`,
        );
      const items = r.items
        .filter((m) => m.type === 'tts' && m.state === 'trained')
        .map((m) => ({
          id: m._id,
          title: m.title,
          description: m.description || '',
          author: m.author || '',
          tags: Array.isArray(m.tags) ? m.tags : [],
          like_count: Number(m.like_count) || 0,
          task_count: Number(m.task_count) || 0,
          sample: Array.isArray(m.samples) && m.samples[0] ? m.samples[0].audio : null,
          in_pool: getVoicePool().some((v) => v.id === m._id),
        }));
      res.json({ items, has_more: r.has_more });
    }),
  );

  // TTS 合成：{text, kind?, project_id?, voice?, speed?, model?} → mp3 落库
  app.post(
    '/api/tts/generate',
    ah(async (req, res) => {
      const b = req.body || {};
      const text = String(b.text || '').trim();
      if (!text) throw new ApiError(400, '请先输入配音文本 text');
      if (text.length > TTS_MAX_TEXT) throw new ApiError(400, `text 长度需 ≤ ${TTS_MAX_TEXT}`);
      const apiKey = settings.get('fish_api_key', '');
      if (!apiKey) throw new ApiError(400, '尚未配置 Fish Audio API Key，请先在「设置」中填写（TTS 配音）');
      const kind = ['narration', 'shot'].includes(b.kind) ? b.kind : 'narration';
      const projectId = b.project_id === undefined || b.project_id === null ? null : Number(b.project_id);
      if (projectId !== null && !projects.get(projectId)) throw new ApiError(404, '项目不存在');
      // v1.3：旁白可绑定到具体镜头（渲染成片时按镜头对齐时间轴）
      const shotId = b.shot_id === undefined || b.shot_id === null ? null : Number(b.shot_id);
      if (shotId !== null) {
        if (projectId === null) throw new ApiError(400, 'shot_id 需与 project_id 同时提供');
        if (!projects.shots(projectId).some((s) => s.id === shotId))
          throw new ApiError(404, '镜头不存在（或不属于该项目）');
      }
      const effKind = b.kind === undefined && shotId !== null ? 'shot' : kind;
      const voice =
        TTS_VOICES.some((v) => v.id === String(b.voice || '')) ||
        getVoicePool().some((v) => v.id === String(b.voice || ''))
          ? String(b.voice)
          : settings.get('fish_voice', 'default');
      const speed = b.speed !== undefined ? Number(b.speed) : Number(settings.get('fish_speed', '1'));
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new ApiError(400, 'speed 需在 0.5–2.0 之间');
      const model = TTS_MODELS.includes(String(b.model)) ? String(b.model) : 's2.1-pro-free';
      const referenceId = voice === 'default' ? null : voice;
      const voiceTitle = TTS_VOICES.find((v) => v.id === voice)?.title || (referenceId ? voice : '平台默认音色');

      const r = await fishTts.synthesize({ apiKey, text, referenceId, model, speed, format: 'mp3' });
      if (!r.ok) {
        const detail = r.raw || `HTTP ${r.status}`;
        if (projectId !== null) {
          projects.addTts({
            project_id: projectId,
            kind: effKind,
            shot_id: shotId,
            text,
            model,
            reference_id: referenceId,
            voice_title: voiceTitle,
            error_message: String(detail).slice(0, 300),
          });
        }
        throw new ApiError(
          r.status >= 400 && r.status < 500 ? 400 : 502,
          `配音生成失败（${r.status}）：${String(detail).slice(0, 300)}`,
        );
      }
      // 保存本地 artifacts
      let localPath = null;
      try {
        fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
        const name = `tts${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`;
        localPath = path.join(ARTIFACTS_DIR, name);
        fs.writeFileSync(localPath, r.buf);
      } catch {
        localPath = null;
      }
      const duration = localPath ? probeDuration(localPath) : null;
      let ttsRow = null;
      if (projectId !== null) {
        const tid = projects.addTts({
          project_id: projectId,
          kind: effKind,
          shot_id: shotId,
          text,
          model,
          reference_id: referenceId,
          voice_title: voiceTitle,
          format: 'mp3',
          local_path: localPath,
          duration,
          size: r.buf ? r.buf.length : null,
        });
        // 第一次生成成功自动选用（与角色图首张自动定稿一致）
        projects.selectTts(tid, projectId);
        ttsRow = projects.getTts(tid);
      }
      log(
        'info',
        `TTS 配音生成成功 ${projectId ? `（项目 #${projectId} ${effKind}${shotId ? ` #镜头${shotId}` : ''}）` : ''} 音色=${voiceTitle} 时长=${duration || '?'}s${localPath ? ' 已存本地' : ''}`,
      );
      res.json({
        ok: true,
        text,
        voice: referenceId,
        voice_title: voiceTitle,
        model,
        duration,
        size: r.buf ? r.buf.length : null,
        local_url: localPath ? '/artifacts/' + path.basename(localPath) : null,
        tts: ttsRow,
      });
    }),
  );

  // 选用配音记录（同项目内 selected 互斥）
  app.post('/api/tts/:id/select', (req, res) => {
    const t = projects.getTts(req.params.id);
    if (!t) throw new ApiError(404, '配音记录不存在');
    const projectId = Number(req.body?.project_id ?? t.project_id);
    if (!projects.get(projectId)) throw new ApiError(404, '项目不存在');
    projects.selectTts(t.id, projectId);
    res.json({ ok: true, tts: projects.getTts(t.id) });
  });

  // v1.5 旁白绑定镜头：{shot_id} 把已有配音记录绑到指定镜头（kind 自动转 shot），成片渲染时按镜头对齐；
  // shot_id 传 null 解绑（kind 回 narration）。同一镜头绑新记录时会自动解绑旧记录。
  app.post('/api/tts/:id/bind', (req, res) => {
    const t = projects.getTts(req.params.id);
    if (!t) throw new ApiError(404, '配音记录不存在');
    if (!t.local_path || t.error_message) throw new ApiError(400, '该配音记录无有效本地音频，无法绑定');
    const projectId = Number(req.body?.project_id ?? t.project_id);
    if (!projects.get(projectId)) throw new ApiError(404, '项目不存在');
    const raw = req.body?.shot_id;
    const shotId = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (shotId !== null) {
      if (!projects.shots(projectId).some((s) => s.id === shotId))
        throw new ApiError(404, '镜头不存在（或不属于该项目）');
      // 同镜头互斥：旧绑定自动解绑为 narration
      for (const other of projects.tts(projectId)) {
        if (other.id !== t.id && other.kind === 'shot' && other.shot_id === shotId) {
          projects.bindTts(other.id, null, null);
        }
      }
    }
    projects.bindTts(t.id, shotId === null ? 'narration' : 'shot', shotId);
    log('info', `配音 #${t.id} ${shotId === null ? '解绑' : `绑定镜头 #${shotId}`}(项目 #${projectId})`);
    res.json({ ok: true, tts: projects.getTts(t.id) });
  });

  // 删除配音记录
  app.delete('/api/tts/:id', (req, res) => {
    if (!projects.removeTts(req.params.id)) throw new ApiError(404, '配音记录不存在');
    res.json({ ok: true });
  });
};
