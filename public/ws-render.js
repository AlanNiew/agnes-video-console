/* ws-render.js —— 创作工作台「纯常量 + 渲染 HTML 函数」模块（M4-B3-1：自 workspace.js 拆出）
 * 全部为无 DOM 副作用、不触碰会话状态的纯函数（esc/fmtTime 唯一依赖），数据一律经参数传入；
 * 本文件只负责「输入 → HTML 字符串」，事件绑定与动作留在 workspace.js。
 * 依赖：common.js（esc、fmtTime）。供 workspace.js 及各步骤模块复用。
 */
import { esc, fmtTime } from './common.js';

const STATUS_LABEL = {
  queued: '队列中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '失败',
  submit_error: '提交失败',
};
const KIND_LABEL = {
  script: '故事梗概',
  video_prompt: '视频提示词',
  character_desc: '角色外观描述',
  scene_desc: '场景描述',
};

/* ---------------- P0：新手引导 + 步骤导航 ---------------- */
/** 各步骤的新手说明（标题一句话 + 展开正文）；①创意由顶部引导条覆盖 */
const STEP_GUIDES = {
  2: {
    tip: '把创意变成「导演剧本」',
    body: 'AI 会把你的创意拆成四份文案（梗概 / 角色外观 / 场景 / 视频提示词）和一份多镜头分镜脚本——每个镜头都有独立的画面描述与旁白。之后所有步骤都基于这份剧本展开，写得越具体，生成越可控。不满意可随时重新生成或手动编辑，历史版本全部保留。',
  },
  3: {
    tip: '给主角拍一张「定妆照」',
    body: '先生成主角的立绘候选，点击其中一张定稿。之后每个镜头的视频都会自动参考这张图，保证主角在所有镜头里长相一致（自动注入「以 Picture 1 为参考，保持外观一致」）。还没定稿也能继续，但镜头提交会受限——强烈推荐先完成这一步。',
  },
  4: {
    tip: '逐镜头出片',
    body: '每个镜头单独生成一段视频：可以单镜提交，也可以「批量提交未完成镜头」（按间隔自动节流，防止触发上游限流；关掉页面也会由后台继续）。完成后镜头下方出现候选区，可「重拍」获取更多版本，点「用这条」为该镜头定稿。',
  },
  5: {
    tip: '给片子配上人声旁白（可选）',
    body: '把文稿交给 TTS 合成人声：用「从分镜填充旁白」快速带入每镜文案，生成后在配音墙试听并「绑定到镜头」，渲染时旁白会与画面自动对齐。想换声音？到「声音广场」试听喜欢的音色加入备选池。',
  },
  6: {
    tip: '给片子挑一首背景音乐（可选）',
    body: '搜索在线曲库、试听、一键选用一首 BGM。渲染时音乐会循环铺底、首尾淡入淡出，有旁白时自动闪避（说话时压低音乐让人声突出）；音量可在下一步「高级配置」中微调。不选 BGM 也可以直接渲染成片。',
  },
  7: {
    tip: '一键合成完整短片',
    body: '把已完成镜头 + 旁白 + BGM 用本地 ffmpeg 合成完整短片：自动叠化转场、字幕烧录、旁白闪避、全片响度标准化（-16 LUFS）。至少需要 2 个已完成镜头。渲染在后台进行，完成后可直接播放、下载，并附 3 张封面候选与质检报告。',
  },
};
const STEP_TITLES = {
  2: '文案与提示词',
  3: '角色设定图',
  4: '视频生成',
  5: '配音',
  6: '背景音乐',
  7: '成片渲染',
};

/* ---------------- P2：成片风格预设（一键套用整套渲染配方） ---------------- */
const FILM_PRESETS = [
  {
    id: 'healing',
    emoji: '🌿',
    label: '治愈慢综',
    desc: '长叠化 + 大字幕 + 音乐温柔铺底，适合风景 / 情感 / 治愈叙事',
    params: {
      transition_ms: 900,
      transition_type: 'dissolve',
      subtitle_style: 'white-outline',
      subtitle_position: 'bottom',
      subtitle_fontsize: 48,
      bgm_volume: 0.4,
      narration_volume: 1.4,
      narration_offset_ms: 500,
      bgm_duck: true,
    },
  },
  {
    id: 'energy',
    emoji: '🔥',
    label: '热血快剪',
    desc: '短硬转场 + 金色字幕 + 高能量配乐，适合燃向混剪 / 运动集锦',
    params: {
      transition_ms: 200,
      transition_type: 'wipeleft',
      subtitle_style: 'yellow-box',
      subtitle_position: 'bottom',
      subtitle_fontsize: 36,
      bgm_volume: 0.55,
      narration_volume: 1.5,
      narration_offset_ms: 300,
      bgm_duck: true,
    },
  },
  {
    id: 'documentary',
    emoji: '🗺️',
    label: '纪录解说',
    desc: '溶解转场 + 底部字幕条 + 低音量配乐，适合人文 / 科普解说',
    params: {
      transition_ms: 600,
      transition_type: 'fade',
      subtitle_style: 'bottom-bar',
      subtitle_position: 'bottom',
      subtitle_fontsize: 40,
      bgm_volume: 0.2,
      narration_volume: 1.5,
      narration_offset_ms: 500,
      bgm_duck: true,
    },
  },
  {
    id: 'lecture',
    emoji: '🎤',
    label: '知识口播',
    desc: '无长转场 + 居中大字幕 + 人声为主，适合口播 / 知识讲解',
    params: {
      transition_ms: 200,
      transition_type: 'fade',
      subtitle_style: 'white-outline',
      subtitle_position: 'center',
      subtitle_fontsize: 52,
      bgm_volume: 0.12,
      narration_volume: 1.6,
      narration_offset_ms: 400,
      bgm_duck: true,
    },
  },
  {
    id: 'fairy',
    emoji: '🧸',
    label: '童话绘本',
    desc: '柔和滑动转场 + 大字幕 + 轻音乐，适合故事 / 儿童内容',
    params: {
      transition_ms: 800,
      transition_type: 'slideup',
      subtitle_style: 'white-outline',
      subtitle_position: 'bottom',
      subtitle_fontsize: 44,
      bgm_volume: 0.35,
      narration_volume: 1.3,
      narration_offset_ms: 600,
      bgm_duck: true,
    },
  },
];
const TRANSITION_LABELS = {
  fade: '淡入淡出',
  dissolve: '溶解',
  wipeleft: '左擦除',
  wiperight: '右擦除',
  slideup: '上滑',
  slidedown: '下滑',
  circleopen: '圆形展开',
};
const SUBSTYLE_LABELS = { 'white-outline': '白字描边', 'yellow-box': '金字底框', 'bottom-bar': '底部字幕条' };
const SUBPOS_LABELS = { bottom: '画面底部', center: '画面居中' };

/* P0：风格预设卡片（新建项目弹窗：一键选风格；仍可自定义输入） */
const STYLE_PRESETS = [
  { emoji: '🎥', label: '电影写实', value: '电影写实，自然光影，浅景深，胶片质感' },
  { emoji: '🌿', label: '治愈温暖', value: '治愈系，暖色调，柔和光线，宫崎骏动画风格' },
  { emoji: '🔥', label: '热血燃向', value: '热血动漫风，强对比色彩，动感构图' },
  { emoji: '🕵️', label: '悬疑紧张', value: '悬疑氛围，冷色调，低调布光，电影感构图' },
  { emoji: '🖌️', label: '国风水墨', value: '中国水墨画风，留白意境，淡雅配色' },
  { emoji: '🧸', label: '童话绘本', value: '童话绘本插画风，明快色彩，圆润造型' },
  { emoji: '🌆', label: '赛博朋克', value: '赛博朋克，霓虹光效，未来都市质感' },
  { emoji: '🗺️', label: '纪录片', value: '纪录片质感，真实自然，高清细节，平实运镜' },
];

/* ---------------- P3：全自动成片进度时间线 ---------------- */
const AUTO_STAGES = [
  ['script', '文案'],
  ['storyboard', '分镜'],
  ['review', 'AI 自审'],
  ['character', '角色图'],
  ['videos', '视频生成'],
  ['tts', '配音'],
  ['bgm', '配乐'],
  ['render', '渲染成片'],
];
const AUTO_STAGE_ALIAS = { wait_videos: 'videos', wait_render: 'render', done: '__done__' };
const AUTO_STAGE_LABEL = {
  script: '生成文案',
  storyboard: '拆分分镜',
  review: 'AI 自审分镜',
  character: '生成角色图',
  videos: '逐镜生成视频',
  wait_videos: '等待视频完成',
  tts: '逐镜配音',
  bgm: '自动选配乐',
  render: '渲染成片',
  wait_render: '等待渲染完成',
  done: '完成',
  error: '人工介入',
  stopped: '已停止',
};

function relTimeAuto(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  return `${Math.floor(s / 3600)}小时前`;
}

/** 自动成片时间线：按阶段推导 done/active/pending，展示最近一条历史 */
function autoTimelineHTML(st) {
  if (!st) return '';
  const key = AUTO_STAGE_ALIAS[st.stage] || st.stage;
  const curIdx = AUTO_STAGES.findIndex(([k]) => k === key);
  const isDone = st.stage === 'done';
  const isError = st.stage === 'error';
  const isStopped = st.stage === 'stopped';
  const steps = AUTO_STAGES.map(([, label], i) => {
    let cls = 'pending';
    if (isDone || (curIdx >= 0 && i < curIdx)) cls = 'done';
    else if (i === curIdx) cls = isError ? 'failed' : isStopped ? 'stopped' : st.running ? 'active' : 'done';
    const icon =
      cls === 'done' ? '✓' : cls === 'failed' ? '✗' : cls === 'stopped' ? '⏸' : cls === 'active' ? '' : i + 1;
    return `<span class="at-step ${cls}">${cls === 'active' ? '<span class="spinner"></span>' : `<b>${icon}</b>`}${esc(label)}</span>`;
  }).join('<span class="at-arrow">→</span>');
  const last = (st.history || []).at(-1);
  const head = isError
    ? `🚨 全自动成片中断 · 需人工介入`
    : isDone
      ? '🎉 全自动成片完成'
      : isStopped
        ? '⏸ 全自动成片已停止（可重新启动）'
        : `🚀 全自动成片进行中 · ${esc(AUTO_STAGE_LABEL[st.stage] || st.stage)}`;
  return `
      <div class="auto-timeline ${isError ? 'at-error' : ''} ${isDone ? 'at-done' : ''}" id="wsAutoTimeline" data-project="${st.projectId || ''}">
        <div class="at-head">
          <span class="at-title">${head}</span>
          ${st.running ? `<button class="btn ghost sm" id="wsAutoStop">停止</button>` : ''}
          ${isError || isStopped ? `<button class="btn primary sm" id="wsAutoRestart">重新自动成片</button>` : ''}
          <span class="spacer" style="flex:1"></span>
          ${st.error ? `<span class="at-err" title="${esc(st.error)}">⚠ ${esc(String(st.error).slice(0, 60))}${st.error.length > 60 ? '…' : ''}</span>` : ''}
        </div>
        <div class="at-steps">${steps}</div>
        ${last ? `<div class="at-last">最近：${esc(last.detail || AUTO_STAGE_LABEL[last.stage] || last.stage)} · ${relTimeAuto(last.ts)}</div>` : ''}
      </div>`;
}

/** 步骤新手引导卡（n=步骤号；showGuide=false 时省略——是否显示由调用方据 localStorage 决定） */
function stepGuideHTML(n, showGuide = true) {
  const g = STEP_GUIDES[n];
  if (!g || !showGuide) return '';
  return `<details class="step-guide">
      <summary>💡 这一步做什么？—— ${esc(g.tip)}</summary>
      <div class="step-guide-body">${esc(g.body)}</div>
    </details>`;
}
/** 步骤底部导航：上一步 / 下一步（下一步的校验在 bindStepNav 内做） */
function stepNavHTML(n, firstStep = 2, lastStep = 7) {
  if (n >= lastStep) return '';
  const prev = n > firstStep ? `<button class="btn ghost sm" data-step-prev="${n}">← 上一步</button>` : '';
  return `<div class="step-nav">${prev}<span class="spacer" style="flex:1"></span><button class="btn primary sm" data-step-next="${n}">下一步：${esc(STEP_TITLES[n + 1] || '')} →</button></div>`;
}

/** 项目卡（项目列表视图） */
function cardHTML(p) {
  return `
      <div class="ws-card" data-id="${p.id}">
        <h3>${esc(p.name)}</h3>
        <div class="idea">${esc(p.idea || '（无简介）')}</div>
        <div class="meta">
          ${p.style ? `<span class="meta-tag">风格：${esc(p.style)}</span>` : ''}
          <span class="meta-tag">${esc(p.aspect_ratio || '16:9')}</span>
          <span class="meta-tag">${esc(p.seconds || '5')}s</span>
        </div>
        <div class="foot">更新于 ${fmtTime(p.updated_at)}</div>
      </div>`;
}

/* 步骤④的模型标签：与流水线实际使用的免费视频模型保持同源 */
function videoModelTag(meta) {
  const m =
    meta.models.find((x) => x.id === 'agnes-video-2.5-flash') ||
    meta.models.find((x) => !x.deprecated && x.free) ||
    meta.models[0];
  return `${m.short}（${m.free ? '免费' : '付费'} · ${(m.sizes || ['-'])[0] || '-'}）`;
}

/* ---------------- M2：第④步镜头提交块 ---------------- */
/** 镜头最新任务（tasks 按 created_at DESC 返回，首个即最新） */
function shotLatestTask(tasks, shotId) {
  return tasks.find((t) => t.shot_id === shotId) || null;
}

function shotStatusBadge(t) {
  if (!t) return '<span class="meta-tag">未提交</span>';
  const label = STATUS_LABEL[t.status] || t.status;
  const pct = t.status === 'in_progress' ? ` ${Number(t.progress) || 0}%` : '';
  return `<span class="meta-tag">${esc(label)}${pct}</span>`;
}

/** 第④步镜头提交块（batchBusy/batchHint 由调用方传入，保持纯函数无状态） */
function renderShotSubmitBlock(shots, tasks, selChar, batchBusy = false, batchHint = '') {
  const pendingShots = shots.filter((s) => {
    const t = shotLatestTask(tasks, s.id);
    return !t || t.status === 'failed' || t.status === 'submit_error';
  });
  return `
      <div class="hint mt">镜头默认引用定稿角色图（自动添加「以 &lt;Picture 1&gt; 为参考，保持外观一致」）；纯空镜镜头可在上方分镜卡片中取消勾选「引用角色图」。</div>
      <div id="wsShotSubmit" class="mt">
        ${shots
          .map((s) => {
            const t = shotLatestTask(tasks, s.id);
            const active = t && (t.status === 'queued' || t.status === 'in_progress');
            const takes = tasks
              .filter((x) => x.shot_id === s.id && x.status === 'completed')
              .sort((a, b) => b.id - a.id);
            return `
          <div class="ver-item shot-submit-row">
            <b>镜头 ${s.seq}</b>${s.title ? ` · ${esc(s.title)}` : ''}
            <span class="meta-tag">${esc(String(s.seconds || '5'))}s</span>
            ${shotStatusBadge(t)}
            <span class="spacer" style="flex:1"></span>
            <button class="btn ghost sm" data-shot-retake="${s.id}" ${batchBusy ? 'disabled' : ''} title="为该镜头再生成一条候选（提交队列自动按分钟节流）">📸 重拍</button>
            <button class="btn primary sm" data-shot-submit="${s.id}" ${selChar && !active && !batchBusy ? '' : 'disabled'}>🚀 提交</button>
            ${
              takes.length
                ? `
            <div style="width:100%;margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px">
              <span class="hint">候选 ${takes.length} 条（渲染${s.take_task_id ? '用 ✓定稿' : '默认用最新'}）：</span>
              ${takes
                .map(
                  (tk) => `
                <span class="meta-tag" style="${tk.id === s.take_task_id ? 'border-color:#2b8a5a;color:#2b8a5a' : ''}">#${tk.id}${tk.id === s.take_task_id ? ' ✓定稿' : ''}</span>
                ${
                  tk.id === s.take_task_id
                    ? `<button class="btn ghost sm" data-take-auto="${s.id}" title="恢复自动模式（渲染用最新完成条）">取消定稿</button>`
                    : `<button class="btn ghost sm" data-take-pick="${s.id}" data-task="${tk.id}" title="渲染时优先使用这条">用这条</button>`
                }
              `,
                )
                .join('')}
            </div>`
                : ''
            }
          </div>`;
          })
          .join('')}
      </div>
      <div class="row mt" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn primary" id="wsBatchSubmit" ${batchBusy || !selChar ? 'disabled' : ''}>
          ${batchBusy ? '批量提交中…' : `🚀 批量提交未完成镜头（${pendingShots.length}/${shots.length}）`}
        </button>
        ${batchBusy ? '<button class="btn ghost sm" id="wsBatchStop">停止批量</button>' : ''}
        <span class="hint" id="wsBatchHint">${esc(batchHint)}</span>
      </div>
      <div class="hint mt">批量提交按设置中的「批量提交间隔」逐个发起；服务端提交队列也按同一间隔节流并自动重试限流（429）——即使关闭页面，已入队任务也会由后台继续提交。</div>`;
}

/** v2.1：单镜头配音按钮（有旁白才显示；已有绑定配音则提示可重新生成） */
function ttsBtnForShot(s, ttsList) {
  if (!(s.narration || '').trim()) return '';
  const bound = (ttsList || []).some(
    (t) => t.kind === 'shot' && t.shot_id === s.id && t.local_path && !t.error_message,
  );
  return `<button class="btn ghost sm" data-shot-tts="${s.id}" title="${bound ? '重新生成本镜配音（覆盖旧绑定）' : '用本镜旁白文案合成配音并自动绑定'}">${bound ? '🎙️ 重配本镜' : '🎙️ 配本镜旁白'}</button>`;
}

/* v2.1 旁白计量：TTS 实测约 4.6 字/秒（标定见 docs/CREATION_PLAYBOOK.md），上限 = 秒数×4 字。
 * 生成端已有 clampNarration 硬限（v2.0.3），此处把同样的规则前移到编辑时即时反馈。 */
const NARR_CPS = 4.6;
function narrMeterHTML(text, seconds) {
  const sec = Number(seconds) || 5;
  const cap = Math.floor(sec * 4);
  const len = (text || '').length;
  if (!len) return ''; // 空旁白不占位（该镜无配音）
  const est = len / NARR_CPS;
  const over = len > cap;
  return `<span class="${over ? 'nm-over' : 'nm-ok'}">${len}/${cap} 字 · 配音 ≈${est.toFixed(1)}s / 镜头 ${sec}s${over ? ' · 超长，渲染时将被截断' : ''}</span>`;
}

/* ---------------- v2.1 渲染前预检（镜头就绪 / 旁白匹配 / 配乐 / 预计时长） ----------------
 * 输入为项目聚合数据（refreshTasks 每 10s 全量拉取，视频后台完成时预检自动转绿）。
 * 旁白匹配口径与渲染器一致：镜头最新绑定配音时长 + 0.5s 偏移 ≤ 镜头标称时长。 */
function renderPrecheckHTML(d, completedShots, narratedShots, shots) {
  const tasks = d.tasks || [];
  const tts = d.tts || [];
  const bgm = d.project?.bgm;
  const chips = [];

  // ① 镜头就绪（硬门槛：≥2 完成镜头，与渲染按钮 disabled 同口径）
  chips.push(
    completedShots >= 2
      ? `<span class="pc-chip ok" title="已完成视频的镜头数">✓ ${completedShots} 镜就绪</span>`
      : `<span class="pc-chip bad" title="渲染至少需要 2 个已完成视频的镜头">✗ 仅 ${completedShots} 镜（需 ≥2）</span>`,
  );

  // ② 旁白匹配：逐镜「最新绑定配音时长 + 0.5s ≤ 镜头时长」（有旁白文案且已配音的镜头才计入）
  let matched = 0;
  let overCount = 0;
  let noAudio = 0;
  for (const s of shots) {
    if (!(s.narration || '').trim()) continue; // 无旁白文案的镜头不参与
    const bound = tts
      .filter((t) => t.kind === 'shot' && t.shot_id === s.id && t.local_path && !t.error_message)
      .sort((a, b) => b.id - a.id)[0];
    if (!bound) {
      noAudio += 1;
      continue;
    }
    if ((Number(bound.duration) || 0) + 0.5 <= Number(s.seconds || 5) * 1.035)
      matched += 1; // 镜头实测约 +3.5%
    else overCount += 1;
  }
  const narrTotal = matched + overCount + noAudio;
  if (narrTotal === 0) {
    chips.push(`<span class="pc-chip warn" title="没有任何镜头填写旁白文案，成片将无配音字幕">⚠ 全片无旁白</span>`);
  } else if (overCount === 0 && noAudio === 0) {
    chips.push(
      `<span class="pc-chip ok" title="所有旁白配音时长均在镜头内">✓ 旁白 ${matched}/${narrTotal} 匹配</span>`,
    );
  } else {
    const parts = [];
    if (overCount) parts.push(`${overCount} 镜超长（渲染时将被截断）`);
    if (noAudio) parts.push(`${noAudio} 镜未配音`);
    chips.push(
      `<span class="pc-chip warn" title="${esc(parts.join('；'))}">⚠ 旁白 ${matched}/${narrTotal} 匹配</span>`,
    );
  }

  // ③ 配乐状态
  if (bgm?.song_id) {
    chips.push(`<span class="pc-chip ok" title="已选用背景音乐">🎵 已配乐</span>`);
  } else if (narratedShots > 0) {
    chips.push(
      `<span class="pc-chip warn" title="有旁白但未选 BGM：建议在第⑥步选一首衬托人声的轻音乐">🎵 建议配乐（有旁白无 BGM）</span>`,
    );
  } else {
    chips.push(`<span class="pc-chip warn" title="无旁白也无 BGM，成片将完全无声">🎵 未配乐（成片将无声）</span>`);
  }

  // ④ 预计时长（信息性）：Σ完成镜头标称时长 + 片头尾卡(6.3s) − 转场叠化(600ms × 缺口数)
  const readyShots = shots.filter((s) => tasks.some((t) => t.shot_id === s.id && t.status === 'completed'));
  if (readyShots.length) {
    const seg = readyShots.reduce((sum, s) => sum + (Number(s.seconds) || 5), 0);
    const est = seg + 6.3 - 0.6 * Math.max(readyShots.length - 1, 0);
    chips.push(
      `<span class="pc-chip info" title="按完成镜头标称时长 + 片头尾卡 − 转场叠化估算">⏱ 预计 ≈${est.toFixed(0)}s</span>`,
    );
  }

  return chips.join('');
}

/** 从项目聚合数据（/api/projects/:id）直接生成渲染前预检——供动作后的「局部刷新」复用；
 * 计数口径与 refreshTasks 周期刷新一致（completed 且有镜头归属），避免整行闪烁。 */
function precheckHtmlFromDetail(d) {
  const tasks = d.tasks || [];
  const shots = d.shots || [];
  const completedShots = tasks.filter((t) => t.status === 'completed' && t.shot_id).length;
  const narratedShots = shots.filter((s) =>
    (d.tts || []).some((t) => t.kind === 'shot' && t.shot_id === s.id && t.local_path && !t.error_message),
  ).length;
  return renderPrecheckHTML(d, completedShots, narratedShots, shots);
}

function renderStoryboardArea(texts, shots, p, meta, ttsList = []) {
  const sbVersions = texts.filter((t) => t.kind === 'storyboard');
  const secondsOpts = (sel) =>
    meta.seconds
      .map(
        (s) =>
          `<option value="${esc(s)}" ${s === String(sel || p.seconds || 5) ? 'selected' : ''}>${esc(s)} 秒</option>`,
      )
      .join('');
  const countSelect = `<select id="wsShotCount" class="meta-tag" style="background:var(--bg)" title="镜头数量">
      <option value="auto">自动</option><option value="3">3 镜</option><option value="5">5 镜</option><option value="8">8 镜</option>
    </select>`;
  const hasLegacyPrompt = Boolean(
    (texts.find((t) => t.kind === 'video_prompt' && t.selected) || texts.find((t) => t.kind === 'video_prompt') || {})
      .content,
  );

  if (!shots.length) {
    // 尚无分镜：保留旧的单条「视频提示词」卡，提供生成/升级入口
    return `
        <div class="copy-sect" data-kind="video_prompt">
          <h4>🎬 分镜脚本 ${sbVersions.length ? `<span class="badge-ver">${sbVersions.length} 版</span>` : ''}</h4>
          <div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            ${countSelect}
            <button class="btn primary sm" id="wsGenStoryboard">✨ 生成分镜</button>
            <button class="btn ghost sm" id="wsPromoteShot" ${hasLegacyPrompt ? '' : 'disabled'} title="把下方当前视频提示词变成 1 个镜头">升级为分镜</button>
          </div>
          <div class="hint mt">生成分镜后，每个镜头可独立编辑、排序、单独提交视频。</div>
          ${renderTextSections(
            texts.filter((t) => t.kind === 'video_prompt'),
            ['video_prompt'],
          )}
        </div>`;
  }

  return `
      <div class="copy-sect" data-kind="storyboard">
        <h4>🎬 分镜脚本 <span class="badge-ver">${shots.length} 镜</span>
          ${sbVersions.length ? `<span class="badge-ver">${sbVersions.length} 版</span>` : ''}
          ${sbVersions.some((t) => t.selected) ? '<span class="badge-selected">使用中</span>' : ''}
        </h4>
        <div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          ${countSelect}
          <button class="btn primary sm" id="wsGenStoryboard">✨ 重新生成分镜</button>
          <button class="btn ghost sm" id="wsReviewSb" title="AI 审查分镜与文案的一致性、节奏与提示词质量，给出可采纳的修订建议">🔍 AI 审查分镜</button>
          <button class="btn ghost sm" id="wsAddShot">＋ 添加镜头</button>
          ${
            sbVersions.length > 1
              ? `<details class="hint" style="display:inline-block"><summary>历史版本</summary><div class="ver-list mt">
            ${sbVersions.map((t) => `<div class="ver-item">#${t.id} · ${fmtTime(t.created_at)}${t.selected ? ' · <b>使用中</b>' : ''} ${t.selected ? '' : `<button class="btn ghost sm" data-apply-sb="${t.id}">选用</button>`}</div>`).join('')}
          </div></details>`
              : ''
          }
        </div>
        <div class="hint mt">每个镜头可独立编辑保存、排序、删除；提交视频在下方第 ④ 步。</div>
        <div id="wsShotList">
          ${shots
            .map(
              (s, i) => `
          <div class="copy-sect shot-card" data-shot-id="${s.id}">
            <div class="shot-head">
              <span class="badge">镜头 ${s.seq}</span>
              <input class="shot-title" data-shot-title value="${esc(s.title || '')}" placeholder="镜头标题（可选，仅用于区分镜头）" title="镜头标题：给你自己看的标记（如「开场·麦田全景」），不会提交给视频模型，也不会被配音朗读" />
              <button class="btn ghost sm" data-shot-up ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
              <button class="btn ghost sm" data-shot-down ${i === shots.length - 1 ? 'disabled' : ''} title="下移">↓</button>
              <button class="btn ghost sm danger" data-shot-del title="删除镜头">✕</button>
            </div>
            <label class="shot-field-label">🖼️ 画面提示词<span class="hint">提交给视频模型生成这一镜的画面（景别、主体、动作、运镜、光线、风格）</span></label>
            <textarea data-shot-prompt rows="3" title="本镜的画面生成提示词">${esc(s.video_prompt)}</textarea>
            <label class="shot-field-label">🎙️ 旁白文案<span class="hint">本镜的人声朗读文稿（渲染时自动与画面对齐；画面提示词不会被拿去配音）</span></label>
            <textarea data-shot-narration rows="2" placeholder="此镜头的旁白台词（可选；留空则该镜无配音）" title="本镜旁白：只用于合成人声，成片时按镜头对齐混入" style="margin-top:2px">${esc(s.narration || '')}</textarea>
            <div class="narr-meter" data-narr-meter>${narrMeterHTML(s.narration || '', s.seconds)}</div>
            <label class="hint" style="display:flex;gap:6px;align-items:center;margin-top:6px">
              <input type="checkbox" data-shot-ref ${s.use_character_ref !== 0 ? 'checked' : ''} />
              引用角色定稿图（纯空镜 / 无人镜头可取消勾选，将以纯文生模式提交）
            </label>
            <div class="row" style="display:flex;gap:10px;align-items:center;margin-top:6px;flex-wrap:wrap">
              <select data-shot-seconds class="meta-tag" style="background:var(--bg)">${secondsOpts(s.seconds)}</select>
              <button class="btn ghost sm" data-shot-save>保存修改</button>
              ${ttsBtnForShot(s, ttsList)}
            </div>
          </div>`,
            )
            .join('')}
        </div>
      </div>`;
}

/* 文案分区渲染（kinds 控制渲染哪几类；分镜区独立于本函数，见 renderStoryboardArea） */
function renderTextSections(texts, kinds = ['script', 'character_desc', 'scene_desc']) {
  const byKind = {};
  for (const t of texts) (byKind[t.kind] = byKind[t.kind] || []).push(t);
  return kinds
    .map((kind) => {
      const list = byKind[kind] || [];
      const latest = list[0] || null;
      const sel = list.find((x) => x.selected) || latest;
      return `
        <div class="copy-sect" data-kind="${kind}">
          <h4>${KIND_LABEL[kind] || kind}
            ${list.length ? `<span class="badge-ver">${list.length} 版</span>` : ''}
            ${sel?.selected ? '<span class="badge-selected">使用中</span>' : ''}
          </h4>
          ${
            sel
              ? `<textarea data-text-id="${sel.id}" rows="3">${esc(sel.content)}</textarea>
            <div class="row">
              <button class="btn ghost sm" data-save-text="${sel.id}">保存修改</button>
              <button class="btn ghost sm" data-use-text="${sel.id}">选用此版本</button>
              ${
                list.length > 1
                  ? `<details class="hint" style="display:inline-block"><summary>历史版本</summary><div class="ver-list mt">
                ${list
                  .slice(1)
                  .map(
                    (t) =>
                      `<div class="ver-item">#${t.id} · ${fmtTime(t.created_at)} · ${esc(t.content.slice(0, 40))}… <button class="btn ghost sm" data-use-text="${t.id}">选用</button></div>`,
                  )
                  .join('')}
              </div></details>`
                  : ''
              }
            </div>`
              : '<div class="muted">（暂无内容，点上方「生成文案」）</div>'
          }
        </div>`;
    })
    .join('');
}

/* 图墙单元 */
function imgCell(x) {
  return `
      <div class="img-cell ${x.selected ? 'selected' : ''}" data-img-id="${x.id}" data-kind="${x.kind}">
        <img src="${esc(x.local_url || x.remote_url)}" alt="角色图 #${x.id}" loading="lazy" />
        ${x.selected ? '<span class="tick">✓</span>' : ''}
        <button class="del" data-del-img="${x.id}" title="删除">✕</button>
      </div>`;
}

/* 项目任务列表（独立渲染，供局部刷新；M2 起按镜头分组） */
function renderTaskList(tasks, shots = []) {
  if (!tasks.length) return '';
  const row = (t) => {
    const playSrc = t.video_local_url || t.metadata_url; // v1.3：本地归档优先（远端链接会过期）
    return `
      <div class="ver-item">
        #${t.id} · ${esc(STATUS_LABEL[t.status] || t.status)} · ${Number(t.progress) > 0 ? `${Number(t.progress)}%` : ''} · ${fmtTime(t.created_at)}
        ${t.superseded ? '<span class="meta-tag" title="该镜头已有更新成功的任务，此失败记录仅供参考">已作废</span>' : ''}
        ${t.status === 'completed' && playSrc ? `<a class="act green" href="${esc(playSrc)}" target="_blank" rel="noopener">播放/下载${t.video_local_url ? '（本地）' : ''}</a>` : ''}
        <a class="act" href="#" data-goto-task="${t.id}" style="margin-left:auto">去任务中心查看</a>
      </div>`;
  };
  const shotMap = new Map(shots.map((s) => [s.id, s]));
  const groups = []; // 有镜头归属的任务
  const others = []; // 无归属（旧流程/镜头已删）
  for (const t of tasks) {
    if (t.shot_id && shotMap.has(t.shot_id)) {
      let g = groups.find((x) => x.shotId === t.shot_id);
      if (!g) {
        g = { shotId: t.shot_id, items: [] };
        groups.push(g);
      }
      g.items.push(t);
    } else {
      others.push(t);
    }
  }
  groups.sort((a, b) => (shotMap.get(a.shotId)?.seq || 0) - (shotMap.get(b.shotId)?.seq || 0));
  return `
      <div class="mt"><b>本项目视频任务：</b></div>
      <div class="ver-list mt">
        ${groups
          .map((g) => {
            const s = shotMap.get(g.shotId);
            return `<div class="mt"><span class="badge">镜头 ${s.seq}</span>${s.title ? ` <span class="muted">${esc(s.title)}</span>` : ''}</div>${g.items.map(row).join('')}`;
          })
          .join('')}
        ${others.length ? `<div class="mt"><span class="badge">其他</span></div>${others.map(row).join('')}` : ''}
      </div>`;
}

/* ---------------- v1.3 成片渲染面板 ---------------- */
const RENDER_STATUS = { queued: '排队中', rendering: '渲染中', completed: '已完成', failed: '失败' };

function bgmCurrentHtml(bgm) {
  if (!bgm?.song_id) return '<span class="hint">未选用 BGM（可选：选用后渲染时循环铺底，有旁白时自动闪避）</span>';
  return `<span class="meta-tag">🎵 ${esc(bgm.name)}${bgm.artist ? ' - ' + esc(bgm.artist) : ''}</span>
      <span class="meta-tag">${esc(bgm.level || '')}</span>
      <button class="btn ghost sm" id="wsBgmClear" title="清除 BGM 选择（本地缓存保留）">✕ 清除</button>`;
}

/* ---------------- v1.9 声音广场（音色备选池） ---------------- */
function renderVoicePool() {
  // 项目详情不含池，使用接口懒加载（见 bindVoiceMarket）
  return '<span class="hint" id="wsMkPoolHint">备选池加载中…</span>';
}

function fmtSecs(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function renderJobItem(j) {
  const active = j.status === 'queued' || j.status === 'rendering';
  // P3 质检摘要：时长/偏差/响度/镜头覆盖/旁白覆盖/字幕行数
  let qualityHtml = '';
  if (j.status === 'completed' && j.quality) {
    const q = j.quality;
    const dev = q.duration_deviation_pct;
    const devTxt = dev === null || dev === undefined ? '' : ` · 时长偏差 ${dev > 0 ? '+' : ''}${dev}%`;
    const loud = q.loudness_lufs !== null && q.loudness_lufs !== undefined ? `${q.loudness_lufs} LUFS` : '?';
    qualityHtml = `<div class="quality-row" title="P3 质检报告">
        <span class="meta-tag">🔍 质检</span>
        <span class="meta-tag">${q.duration_s}s${devTxt}</span>
        <span class="meta-tag">响度 ${loud}</span>
        <span class="meta-tag">${q.shots} 镜 · 旁白 ${q.narrated_shots}/${q.shots}</span>
        <span class="meta-tag">字幕 ${q.sub_lines} 行</span>
      </div>`;
  }
  return `
    <div class="ver-item" data-render-job="${j.id}">
      <b>渲染 #${j.id}</b> · ${esc(RENDER_STATUS[j.status] || j.status)}${active ? ` · ${j.progress || 0}%` : ''} · ${fmtTime(j.created_at)}
      ${active ? `<div style="height:6px;background:var(--bg,#1a1f2b);border-radius:3px;overflow:hidden;margin-top:6px"><div style="height:100%;width:${j.progress || 0}%;background:#4f7cff;transition:width .5s"></div></div>` : ''}
      ${
        j.status === 'completed' && j.output_url
          ? `<div style="margin-top:6px"><video controls preload="metadata" src="${esc(j.output_url)}" style="max-width:100%;border-radius:6px"></video>
        <div style="margin-top:6px"><a class="btn ghost sm" href="${esc(j.output_url)}" download>⬇️ 下载成片</a></div></div>`
          : ''
      }
      ${
        j.work_dir
          ? `<div class="work-dir-row" title="${esc(j.work_dir)}">📁 作品已归档：${esc(j.work_dir)}（成片 / 字幕 / 旁白台词 / 海报）</div>`
          : ''
      }
      ${qualityHtml}
      ${
        (j.covers || []).length
          ? `<div style="margin-top:6px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <span class="hint">封面候选：</span>
        ${j.covers.map((c) => `<a href="${esc(c.url)}" download title="点击下载封面"><img src="${esc(c.url)}" style="height:72px;border-radius:4px;border:1px solid #333" /></a>`).join('')}
      </div>`
          : ''
      }
      ${j.error_message ? `<div class="hint" style="color:#e5484d;margin-top:4px">✗ ${esc(j.error_message)}</div>` : ''}
    </div>`;
}

/** 配音墙（渲染 tts 列表；绑定按钮由 bindTtsEvents 委托处理） */
function renderTtsWall(list, shots = []) {
  if (!list || !list.length) return '<div class="hint">还没有配音记录。填入文稿后点「🗣️ 生成配音」。</div>';
  const shotOpts = (cur) =>
    ['<option value="">旁白（未绑镜头）</option>']
      .concat(
        shots.map(
          (s) =>
            `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>镜头 ${s.seq}${s.title ? ' · ' + esc(s.title) : ''}</option>`,
        ),
      )
      .join('');
  return `
      <div class="tts-wall">
        ${list
          .map((t) => {
            const bound = t.kind === 'shot' && t.shot_id;
            const boundShot = bound ? shots.find((s) => s.id === t.shot_id) : null;
            return `
          <div class="tts-item ${t.selected ? 'selected' : ''}" data-tts-id="${t.id}" style="border:1px solid ${t.selected ? 'var(--accent,#2b8a5a)' : 'var(--line,#e3e3e3)'};border-radius:8px;padding:10px 12px;margin-bottom:8px;background:${t.selected ? 'var(--bg-soft,#f2f8f4)' : 'transparent'}">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span class="meta-tag">${esc(t.voice_title || t.reference_id || '默认音色')}</span>
              <span class="meta-tag">${esc(t.model || '')}</span>
              <span class="meta-tag">${t.duration != null ? t.duration + 's' : '—'}</span>
              <span class="meta-tag">${t.size != null ? Math.round(t.size / 1024) + 'KB' : '—'}</span>
              ${bound ? `<span class="meta-tag" title="已绑定镜头，成片渲染时按镜头对齐混入">🎬 镜头 ${boundShot ? boundShot.seq : '?'}</span>` : ''}
              ${t.selected ? '<span class="badge-selected">✓ 选用</span>' : ''}
              <span class="spacer" style="flex:1"></span>
              ${t.local_url ? `<button class="btn ghost sm" data-tts-play="${esc(t.local_url)}">▶ 试听</button>` : ''}
              ${!t.selected && t.local_url ? '<button class="btn ghost sm" data-tts-select>选用</button>' : ''}
              <button class="btn ghost sm danger" data-tts-del title="删除记录与本地音频">删除</button>
            </div>
            <div style="margin-top:6px;color:var(--muted,#888);font-size:12px">${esc(t.text || '')}</div>
            ${
              t.local_url && !t.error_message && shots.length
                ? `
            <div style="margin-top:6px;display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted,#888)">
              绑定到镜头（成片渲染按镜头对齐混入）：
              <select class="meta-tag" data-tts-bind style="background:var(--bg)">${shotOpts(bound ? t.shot_id : null)}</select>
            </div>`
                : ''
            }
            ${t.error_message ? `<div style="margin-top:4px;color:var(--danger,#c0392b);font-size:12px">失败：${esc(t.error_message)}</div>` : ''}
          </div>`;
          })
          .join('')}
      </div>
      <div class="hint mt">提示：「绑定到镜头」的配音会在成片渲染时按镜头起幅点自动对齐混入（同一镜头多次绑定以最新一条为准）；未绑定的记录仅作整片旁白素材保留。</div>`;
}

export {
  STYLE_PRESETS,
  FILM_PRESETS,
  TRANSITION_LABELS,
  SUBSTYLE_LABELS,
  SUBPOS_LABELS,
  autoTimelineHTML,
  stepGuideHTML,
  stepNavHTML,
  cardHTML,
  videoModelTag,
  renderShotSubmitBlock,
  shotLatestTask,
  narrMeterHTML,
  renderPrecheckHTML,
  precheckHtmlFromDetail,
  renderStoryboardArea,
  renderTextSections,
  imgCell,
  renderTaskList,
  bgmCurrentHtml,
  renderVoicePool,
  fmtSecs,
  renderJobItem,
  renderTtsWall,
};
