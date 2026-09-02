'use strict';
/**
 * routes/llm.js —— 文本生成三端点（v1.9.1 拆分自 server.js）
 * /api/llm/chat（通用 OpenAI 兼容）/ script（结构化文案）/ storyboard（分镜）
 */
const { settings, DEFAULT_SETTINGS, projects } = require('../db');
const agnes = require('../agnes');
const { log } = require('../logger');
const {
  MAX_MESSAGES,
  MAX_TEXT_LEN,
  LLM_MODEL,
  ASPECT_RATIOS,
  SECONDS_OK,
  SCRIPT_KINDS,
  SHOT_COUNTS,
} = require('../constants');
const { ApiError, ah } = require('../errors');
const {
  SCRIPT_SYSTEM_PROMPT,
  STORYBOARD_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  parseLLMJson,
  normalizeStoryboardShots,
  normalizeReviewResult,
} = require('../services/prompts');

module.exports = function registerLlmRoutes(app) {
  // 通用文本生成（OpenAI 兼容）
  app.post(
    '/api/llm/chat',
    ah(async (req, res) => {
      const b = req.body || {};
      const messages = Array.isArray(b.messages) ? b.messages : [];
      if (!messages.length) throw new ApiError(400, 'messages 至少需要一条消息');
      if (messages.length > MAX_MESSAGES) throw new ApiError(400, `messages 最多 ${MAX_MESSAGES} 条`);
      for (const m of messages) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
          throw new ApiError(400, 'messages 每项需为 {role, content} 对象');
        }
        if (!['system', 'user', 'assistant'].includes(m.role)) {
          throw new ApiError(400, `messages role 仅支持 system/user/assistant，收到：${m.role}`);
        }
        if (typeof m.content !== 'string' || !m.content.trim()) {
          throw new ApiError(400, 'messages 每项 content 必须是非空字符串');
        }
        if (m.content.length > MAX_TEXT_LEN) {
          throw new ApiError(400, `messages 单条 content 长度需 ≤ ${MAX_TEXT_LEN}`);
        }
      }
      if (b.system !== undefined && (typeof b.system !== 'string' || b.system.length > MAX_TEXT_LEN)) {
        throw new ApiError(400, `system 必须是长度 ≤ ${MAX_TEXT_LEN} 的字符串`);
      }
      const temperature = b.temperature !== undefined ? Number(b.temperature) : undefined;
      if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
        throw new ApiError(400, 'temperature 需在 0–2 之间');
      }
      const maxTokens = b.max_tokens !== undefined ? Number(b.max_tokens) : undefined;
      if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192)) {
        throw new ApiError(400, 'max_tokens 需为 1–8192 的整数');
      }
      if (b.model !== undefined && b.model !== LLM_MODEL) {
        throw new ApiError(400, `暂只支持文本模型 ${LLM_MODEL}，收到：${b.model}`);
      }
      if (b.system) messages.unshift({ role: 'system', content: b.system });
      const apiKey = settings.get('api_key', '');
      if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
      let r;
      try {
        r = await agnes.chatComplete({
          apiKey,
          baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
          model: LLM_MODEL,
          messages,
          temperature,
          max_tokens: maxTokens,
        });
      } catch (e) {
        throw new ApiError(502, `文本生成网络异常：${e.message}`);
      }
      if (!r.ok) {
        const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
        throw new ApiError(
          r.status >= 400 && r.status < 500 ? 400 : 502,
          `文本生成失败（${r.status}）：${String(detail).slice(0, 400)}`,
        );
      }
      const content = r.data?.choices?.[0]?.message?.content || '';
      if (!content) throw new ApiError(502, '文本模型未返回内容');
      res.json({ content, model: r.data?.model || LLM_MODEL });
    }),
  );

  // 创意 → 结构化文案（流水线第 2 步）
  app.post(
    '/api/llm/script',
    ah(async (req, res) => {
      const b = req.body || {};
      const idea = String(b.idea || '').trim();
      if (!idea) throw new ApiError(400, '请先输入创意想法 idea');
      if (idea.length > MAX_TEXT_LEN) throw new ApiError(400, `idea 长度需 ≤ ${MAX_TEXT_LEN}`);
      const style = b.style ? String(b.style).trim().slice(0, 200) : '';
      if (b.aspect_ratio !== undefined && !ASPECT_RATIOS.includes(b.aspect_ratio)) {
        throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
      }
      if (b.seconds !== undefined && !SECONDS_OK.includes(String(b.seconds))) {
        throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
      }
      if (b.project_id !== undefined && !projects.get(b.project_id)) throw new ApiError(404, '项目不存在');
      const userMessage = `一句话创意：${idea}\n风格偏好：${style || '不限制'}\n画幅：${b.aspect_ratio || '16:9'}\n目标时长：${b.seconds || '5'} 秒`;
      const apiKey = settings.get('api_key', '');
      if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
      let r;
      try {
        r = await agnes.chatComplete({
          apiKey,
          baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: SCRIPT_SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.8,
          max_tokens: 2000,
        });
      } catch (e) {
        throw new ApiError(502, `文案生成网络异常：${e.message}`);
      }
      if (!r.ok) {
        const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
        throw new ApiError(
          r.status >= 400 && r.status < 500 ? 400 : 502,
          `文案生成失败（${r.status}）：${String(detail).slice(0, 400)}`,
        );
      }
      const raw = r.data?.choices?.[0]?.message?.content || '';
      const parsed = parseLLMJson(raw);
      if (!parsed || typeof parsed !== 'object') {
        // 降级：模型没按 JSON 输出，返回原文由前端展示
        return res.json({ parsed: false, content: raw, result: null });
      }
      const result = {
        script: String(parsed.script || '').trim(),
        video_prompt: String(parsed.video_prompt || '').trim(),
        character_desc: String(parsed.character_desc || '').trim(),
        scene_desc: String(parsed.scene_desc || '').trim(),
      };
      // 落库到项目（若指定）。auto_select=false 时新版只落库不选中：
      // 前端弹「新旧对比」窗，由用户决定采用（再调 select-text）还是保留当前版本
      const autoSelect = b.auto_select === undefined ? true : Boolean(b.auto_select);
      let texts = null;
      let newTextIds = null;
      let previous = null;
      if (b.project_id) {
        if (!autoSelect) {
          previous = {};
          newTextIds = {};
          for (const kind of SCRIPT_KINDS) {
            const cur =
              projects.selectedText(b.project_id, kind) ||
              projects.texts(b.project_id).find((t) => t.kind === kind) ||
              null;
            if (cur) previous[kind] = { id: cur.id, content: cur.content };
          }
        }
        for (const kind of SCRIPT_KINDS) {
          if (!result[kind]) continue;
          const tid = projects.addText({ project_id: b.project_id, kind, content: result[kind], model: LLM_MODEL });
          if (autoSelect) projects.selectText(tid, kind, b.project_id);
          else newTextIds[kind] = tid;
        }
        if (autoSelect) projects.update(b.project_id, { status: 'copy_done' });
        texts = projects.texts(b.project_id);
        log('info', `项目 #${b.project_id} 文案生成完成${autoSelect ? '' : '（待用户确认采用）'}`);
      }
      res.json({ parsed: true, result, texts, new_text_ids: newTextIds, previous, model: r.data?.model || LLM_MODEL });
    }),
  );

  // 创意 → 分镜脚本（M2：多镜头 storyboard；整体版本落 project_texts.kind=storyboard，工作副本落 shots）
  app.post(
    '/api/llm/storyboard',
    ah(async (req, res) => {
      const b = req.body || {};
      const idea = String(b.idea || '').trim();
      if (!idea) throw new ApiError(400, '请先输入创意想法 idea');
      if (idea.length > MAX_TEXT_LEN) throw new ApiError(400, `idea 长度需 ≤ ${MAX_TEXT_LEN}`);
      const style = b.style ? String(b.style).trim().slice(0, 200) : '';
      const shotCount = SHOT_COUNTS.includes(String(b.shot_count)) ? String(b.shot_count) : 'auto';
      if (b.aspect_ratio !== undefined && !ASPECT_RATIOS.includes(b.aspect_ratio)) {
        throw new ApiError(400, `aspect_ratio 仅支持 ${ASPECT_RATIOS.join('/')}`);
      }
      if (b.seconds !== undefined && !SECONDS_OK.includes(String(b.seconds))) {
        throw new ApiError(400, 'seconds 仅支持 "4"–"12"');
      }
      if (b.project_id !== undefined && b.project_id !== null && !projects.get(b.project_id)) {
        throw new ApiError(404, '项目不存在');
      }
      const countText = shotCount === 'auto' ? '未指定（按叙事需要 3~8 个）' : `恰好 ${shotCount} 个`;
      const userMessage = `一句话创意：${idea}\n风格偏好：${style || '不限制'}\n画幅：${b.aspect_ratio || '16:9'}\n单镜头目标时长：${b.seconds || '5'} 秒\n镜头数量：${countText}`;
      const apiKey = settings.get('api_key', '');
      if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
      let r;
      try {
        r = await agnes.chatComplete({
          apiKey,
          baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: STORYBOARD_SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.8,
          max_tokens: 4000,
        });
      } catch (e) {
        throw new ApiError(502, `分镜生成网络异常：${e.message}`);
      }
      if (!r.ok) {
        const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
        throw new ApiError(
          r.status >= 400 && r.status < 500 ? 400 : 502,
          `分镜生成失败（${r.status}）：${String(detail).slice(0, 400)}`,
        );
      }
      const raw = r.data?.choices?.[0]?.message?.content || '';
      const parsed = parseLLMJson(raw);
      const rawShots = parsed && typeof parsed === 'object' && Array.isArray(parsed.shots) ? parsed.shots : null;
      if (!rawShots) {
        // 降级：模型没按 JSON 输出，返回原文由前端展示
        return res.json({ parsed: false, content: raw, shots: null, texts: null });
      }
      // 规范化镜头：重编 seq、裁剪长度、seconds 白名单兜底（与历史版本选用共用同一规范化）
      const normalized = normalizeStoryboardShots(
        rawShots,
        SECONDS_OK.includes(String(b.seconds)) ? String(b.seconds) : '5',
      );
      if (!normalized.length) {
        return res.json({ parsed: false, content: raw, shots: null, texts: null });
      }
      let shotsOut = null;
      let texts = null;
      // auto_select=false：仅落 storyboard 版本，不选中、不重建 shots —— 前端弹对比窗，
      // 用户「采用新版」时调 /storyboard/apply（选中 + 重建），「保留当前」则无副作用
      const autoSelect = b.auto_select === undefined ? true : Boolean(b.auto_select);
      if (b.project_id) {
        const content = JSON.stringify({ shots: normalized });
        const tid = projects.addText({ project_id: b.project_id, kind: 'storyboard', content, model: LLM_MODEL });
        if (autoSelect) {
          projects.selectText(tid, 'storyboard', b.project_id);
          projects.replaceShots(b.project_id, normalized);
          shotsOut = projects.shots(b.project_id);
          texts = projects.texts(b.project_id);
          log('info', `项目 #${b.project_id} 分镜生成完成（${normalized.length} 个镜头）`);
        } else {
          shotsOut = normalized;
          texts = projects.texts(b.project_id);
          log('info', `项目 #${b.project_id} 分镜生成待确认（新版本 #${tid}，${normalized.length} 个镜头）`);
          return res.json({
            parsed: true,
            shots: shotsOut,
            current_shots: projects.shots(b.project_id),
            text_id: tid,
            auto_selected: false,
            texts,
            model: r.data?.model || LLM_MODEL,
          });
        }
      } else {
        shotsOut = normalized;
      }
      res.json({ parsed: true, shots: shotsOut, auto_selected: true, texts, model: r.data?.model || LLM_MODEL });
    }),
  );

  // P3 L1：分镜 AI 自审 —— 审查当前分镜与文案一致性 / 节奏 / 提示词质量，返回结构化修订建议
  // （前端弹审查报告，逐条决定采纳；auto.js 全自动管道中自动采纳中低严重度）
  app.post(
    '/api/projects/:id/storyboard/review',
    ah(async (req, res) => {
      const pid = Number(req.params.id);
      const p = projects.get(pid);
      if (!p) throw new ApiError(404, '项目不存在');
      const shots = projects.shots(pid);
      if (!shots.length) throw new ApiError(400, '项目还没有分镜，请先生成分镜');
      const script = projects.selectedText(pid, 'script')?.content || '';
      const charDesc = projects.selectedText(pid, 'character_desc')?.content || '';
      const storyboardText = projects
        .texts(pid)
        .filter((t) => t.kind === 'storyboard' && t.selected)
        .map((t) => t.content)
        .join('\n');
      const userMessage = `【故事梗概】\n${script || p.idea}\n\n【角色描述】\n${charDesc || '（未提供）'}\n\n【分镜脚本（JSON）】\n${storyboardText || JSON.stringify(shots)}`;
      const apiKey = settings.get('api_key', '');
      if (!apiKey) throw new ApiError(400, '尚未配置 API Key，请先在“设置”中填写');
      let r;
      try {
        r = await agnes.chatComplete({
          apiKey,
          baseUrl: settings.get('base_url', DEFAULT_SETTINGS.base_url),
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: REVIEW_SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.3,
          max_tokens: 3000,
        });
      } catch (e) {
        throw new ApiError(502, `分镜审查网络异常：${e.message}`);
      }
      if (!r.ok) {
        const detail = r.data?.error?.message || r.raw || `HTTP ${r.status}`;
        throw new ApiError(502, `分镜审查失败（${r.status}）：${String(detail).slice(0, 400)}`);
      }
      const raw = r.data?.choices?.[0]?.message?.content || '';
      const reviewed = normalizeReviewResult(parseLLMJson(raw));
      if (!reviewed) return res.json({ parsed: false, content: raw, issues: null });
      res.json({ parsed: true, issues: reviewed.issues, overall: reviewed.overall });
    }),
  );
};
