/* settings-panel.js —— 设置弹窗 + 顶栏连接状态（M4-B2：自 app.js 拆出）
 * 负责：GET/PUT /api/settings、TTS 音色（Fish Audio）与 BGM（音乐接口）配置读写；
 * renderConn 供 task-center 在任务刷新失败/恢复时更新顶栏连接提示。
 * 依赖：common.js、task-meta.js（模型下拉与旧模型兜底）。
 */
import { $, esc, toast, api } from './common.js';
import { modelInfo, zhipuMeta, zhipuModelInfo, DEFAULT_MODEL, onModelChange } from './task-meta.js';

const settingsState = { settings: null };

/** 顶栏连接状态（未连接 / 已连接 / 中断） */
function renderConn(ok) {
  const sub = $('#brandSub');
  if (!ok) {
    sub.textContent = '连接中断 · 无法访问本地服务，请确认 server.js 是否在运行';
    sub.className = 'brand-sub offline';
    return;
  }
  const s = settingsState.settings;
  if (s && s.api_key_set) {
    sub.textContent = `已连接 · ${s.base_url} · 轮询 ${s.poll_interval_ms}ms · Key ${s.api_key_masked}`;
    sub.className = 'brand-sub online';
  } else {
    sub.textContent = '未连接 · 请先在设置中填写 API Key';
    sub.className = 'brand-sub offline';
  }
}

let fishVoicesCache = null;
async function loadFishVoices() {
  if (!fishVoicesCache) {
    try {
      fishVoicesCache = await api('/api/tts/voices');
    } catch {
      fishVoicesCache = { voices: [] };
    }
  }
  return fishVoicesCache;
}

async function loadSettings() {
  try {
    settingsState.settings = await api('/api/settings');
    renderConn(true);
    $('#keyStatus').textContent = settingsState.settings.api_key_set
      ? `（已保存 ${settingsState.settings.api_key_masked}，留空则不修改）`
      : '（未配置）';
    // 旧模型兜底：设置里的默认模型若已下架，则回退默认免费模型。
    // 智谱模型不在 META.models 里（走 zhipu 字段），故必须一起判断，否则用户选过的
    // CogVideoX 会被静默判为「已下架」而回退。
    const s = settingsState.settings;
    const known = Boolean(modelInfo(s.model) || zhipuModelInfo(s.model));
    const m = known ? s.model : DEFAULT_MODEL();
    $('#fModel').value = m;
    onModelChange();
    $('#setModel').value = m; // 设置弹窗同样做旧模型兜底，避免静默不选中
    $('#setBaseUrl').value = s.base_url;
    $('#setPollMs').value = s.poll_interval_ms;
    $('#setMaxMin').value = s.max_active_minutes;
    $('#setSubmitMs').value = s.submit_interval_ms ?? 60000;
    // TTS（Fish Audio）
    $('#fishKeyStatus').textContent = settingsState.settings.fish_api_key_set
      ? `（已保存 ${settingsState.settings.fish_api_key_masked}，留空则不修改）`
      : '（未配置）';
    $('#setFishSpeed').value = settingsState.settings.fish_speed ?? 1;
    const fv = await loadFishVoices();
    const curVoice = settingsState.settings.fish_voice || 'default';
    $('#setFishVoice').innerHTML = (fv.voices || [])
      .map((v) => `<option value="${esc(v.id)}" ${v.id === curVoice ? 'selected' : ''}>${esc(v.title)}</option>`)
      .join('');
    // v1.4 BGM（音乐接口）
    $('#setMusicBase').value = settingsState.settings.music_api_base || '';
    $('#musicTokenStatus').textContent = settingsState.settings.music_api_token_set
      ? '（已保存，留空则不修改）'
      : '（未配置）';
    $('#setMusicLevel').value = settingsState.settings.music_level || 'exhigh';
    // v2.3：视频完成后自动下载本地开关
    $('#setAutoDownload').checked = settingsState.settings.video_auto_download === true;
    // 即梦成本确认阈值（积分）
    $('#setDmThreshold').value = settingsState.settings.dreamina_confirm_threshold ?? 10;
    // 全自动成片的角色图是否用即梦（默认开）
    $('#setDmAutoChar').checked = settingsState.settings.dreamina_auto_character === true;
    // —— v2.7 智谱 CogVideoX（Agnes 免费档 503 后的视频替代主力）——
    // 注意：真实 Key 永远不回填 DOM，只回显掩码（placeholder + 状态文案），
    // 否则任何能读到页面的人都拿到了明文 Key。
    const zpKeySet = Boolean(s.zhipu_api_key_set);
    $('#setZpEnabled').checked = s.zhipu_enabled === true;
    $('#setZpBaseUrl').value = s.zhipu_base_url || '';
    $('#setZpKey').value = '';
    $('#setZpKey').placeholder = zpKeySet
      ? `已保存 ${s.zhipu_api_key_masked}，留空则不修改`
      : '粘贴智谱 API Key（bigmodel.cn 控制台获取）';
    $('#setZpKeyStatus').textContent = zpKeySet ? `（已保存 ${s.zhipu_api_key_masked}，留空则不修改）` : '（未配置）';
    // 默认模型下拉：数据取 /api/meta 的 zhipu.models（与新建任务下拉同源），此处只赋选中值
    const zpList = zhipuMeta()?.models || [];
    const zpSel = $('#setZpModel');
    if (zpSel) {
      zpSel.innerHTML = zpList.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
      zpSel.value = s.zhipu_model || zpList[0]?.id || 'cogvideox-flash';
    }
    $('#setZpQuality').value = s.zhipu_quality || 'speed';
    $('#setZpWatermark').checked = s.zhipu_watermark === true;
    // v2.7.2：默认开（免费档限流时自动改投 0.5 元/条付费档；关掉=只等待不花钱）
    if ($('#setZpPaidFallback')) $('#setZpPaidFallback').checked = s.zhipu_paid_fallback !== false;
    $('#setZpMaxMin').value = s.zhipu_max_active_minutes ?? 30;
    renderZhipuState();
    // 即梦 CLI 状态（独立端点，失败不影响设置面板其余部分）
    loadDreaminaStatus();
  } catch (e) {
    toast('加载设置失败：' + e.message, 'err');
  }
}

async function saveSettings() {
  const btn = $('#btnSaveSettings');
  btn.disabled = true;
  try {
    const body = {
      base_url: $('#setBaseUrl').value.trim(),
      poll_interval_ms: Number($('#setPollMs').value),
      max_active_minutes: Number($('#setMaxMin').value),
      submit_interval_ms: Number($('#setSubmitMs').value),
    };
    // 默认模型只在用户真的改过时才发送：后端有「本次填了智谱 Key 且未显式给 model → 自动把
    // 默认模型切到 CogVideoX-Flash」的便利逻辑；若这里无条件带上 model，会把该逻辑顶掉，
    // 用户保存完 Key 还得手动再切一次模型（否则第一次提交仍 503，白跑一趟）。
    const setModel = $('#setModel').value;
    if (setModel && setModel !== settingsState.settings?.model) body.model = setModel;
    const key = $('#setApiKey').value.trim();
    if (key) body.api_key = key;
    const fishKey = $('#setFishKey').value.trim();
    if (fishKey) body.fish_api_key = fishKey;
    const fishVoice = $('#setFishVoice').value;
    if (fishVoice) body.fish_voice = fishVoice;
    const fishSpeedRaw = $('#setFishSpeed').value.trim();
    if (fishSpeedRaw !== '') {
      const fishSpeed = Number(fishSpeedRaw);
      if (!Number.isFinite(fishSpeed) || fishSpeed < 0.5 || fishSpeed > 2) {
        toast('语速需在 0.5–2.0 之间，请调整后再保存', 'warn');
        return;
      }
      body.fish_speed = fishSpeed;
    }
    // v1.4 BGM（音乐接口）
    body.music_api_base = $('#setMusicBase').value.trim();
    const musicToken = $('#setMusicToken').value.trim();
    if (musicToken) body.music_api_token = musicToken;
    const musicLevel = $('#setMusicLevel').value;
    if (musicLevel) body.music_level = musicLevel;
    // v2.3：视频完成后自动下载本地开关（PUT 按布尔处理）
    body.video_auto_download = $('#setAutoDownload').checked;
    // 即梦成本确认阈值（积分；0 = 每次即梦调用都确认）
    const dmThreshold = $('#setDmThreshold').value.trim();
    if (dmThreshold !== '') body.dreamina_confirm_threshold = Number(dmThreshold);
    // 全自动成片的角色图是否用即梦（PUT 按布尔处理）
    body.dreamina_auto_character = $('#setDmAutoChar').checked;
    // —— v2.7 智谱 CogVideoX（Agnes 免费档 503 后的视频替代主力）——
    body.zhipu_enabled = $('#setZpEnabled').checked;
    const zpBase = $('#setZpBaseUrl').value.trim();
    if (zpBase) body.zhipu_base_url = zpBase; // 空 = 不改（后端会归一化成 https://host）
    const zpKey = $('#setZpKey').value.trim();
    if (zpKey) body.zhipu_api_key = zpKey; // 空 = 不改；掩码永不回写
    const zpModel = $('#setZpModel').value;
    if (zpModel) body.zhipu_model = zpModel;
    body.zhipu_quality = $('#setZpQuality').value;
    body.zhipu_watermark = $('#setZpWatermark').checked;
    const zpMax = Number($('#setZpMaxMin').value);
    if (!Number.isFinite(zpMax) || zpMax < 1 || zpMax > 1440) {
      toast('智谱任务超时需在 1–1440 分钟之间，请调整后再保存', 'warn');
      return;
    }
    body.zhipu_max_active_minutes = zpMax;
    // v2.7.2：免费档限流时是否自动改投付费档（默认开；关掉=不产生费用）
    body.zhipu_paid_fallback = $('#setZpPaidFallback') ? $('#setZpPaidFallback').checked : true;
    await api('/api/settings', { method: 'PUT', body });
    toast('设置已保存', 'ok');
    $('#settingsModal').hidden = true;
    $('#setApiKey').value = '';
    $('#setFishKey').value = '';
    $('#setMusicToken').value = '';
    $('#setZpKey').value = '';
    await loadSettings();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 智谱 CogVideoX（v2.7 视频主力） ----------------
 * Agnes 免费档每次提交都 503 video_queue_full、免费 v2.0 已下线，故智谱长期免费的
 * CogVideoX-Flash 是当前唯一可用的免费视频通道。这里只做启用状态联动：
 * 关掉开关时把整块变灰 + 明确写「视频仍走 Agnes」，避免用户以为已经切走。 */
function renderZhipuState() {
  const on = $('#setZpEnabled').checked;
  $('#zpPanel')?.classList.toggle('is-off', !on);
  const st = $('#zpStatus');
  if (st) st.textContent = on ? '（已启用）' : '（未启用 · 视频仍走 Agnes）';
}

/* ---------------- 即梦 CLI（可选上游；docs/DREAMINA_CLI_PLAN.md 阶段 2） ----------------
 * 状态/登录独立于「保存设置」：登录按钮即时生效，阈值才随表单保存。
 * 未安装 / 未登录时仅作提示，不影响设置面板其余部分。 */

const dmState = { status: null, timer: null, deviceCode: null, tries: 0 };

/** 渲染即梦状态区块 */
function renderDreamina() {
  const wrap = $('#dmInfo');
  const s = dmState.status;
  if (!wrap) return;
  // label 旁的状态摘要（与 #keyStatus / #fishKeyStatus 同一模式）
  const st = $('#dmStatus');
  if (st) {
    st.textContent = !s ? '' : s.logged_in ? '（已登录）' : s.installed ? '（未登录）' : '（未安装）';
  }
  if (!s) {
    wrap.textContent = '状态未知';
    return;
  }
  if (!s.installed) {
    wrap.innerHTML = '<span class="dm-badge off">未安装</span> 需先安装官方 dreamina CLI（见 AGENTS.md）';
    $('#dmLoginBtn').hidden = true;
    $('#dmLogoutBtn').hidden = true;
    $('#dmLoginBox').hidden = true;
    return;
  }
  if (!s.logged_in) {
    wrap.innerHTML = '<span class="dm-badge off">未登录</span> 登录后即可使用即梦图片 / 视频能力';
    $('#dmLoginBtn').hidden = false;
    $('#dmLogoutBtn').hidden = true;
    return;
  }
  const credit = s.total_credit === null || s.total_credit === undefined ? '—' : s.total_credit;
  const vip = s.vip_level ? `· VIP ${esc(String(s.vip_level))}` : '';
  const stale = s.stale ? ' <span class="hint">（缓存值）</span>' : '';
  wrap.innerHTML = `<span class="dm-badge on">已登录</span> 可用积分 <b>${esc(String(credit))}</b>${stale} ${vip}`;
  $('#dmLoginBtn').hidden = true;
  $('#dmLogoutBtn').hidden = false;
  $('#dmLoginBox').hidden = true;
}

/** 拉取即梦状态（refresh=true 绕过服务端 60s 缓存） */
async function loadDreaminaStatus(refresh = false) {
  try {
    dmState.status = await api('/api/dreamina/status' + (refresh ? '?refresh=1' : ''));
  } catch (e) {
    dmState.status = { installed: false, logged_in: false, message: e.message };
  }
  renderDreamina();
}

/** 发起无头登录并轮询收尾（授权码约 10 分钟过期，故限制轮询次数） */
async function startDreaminaLogin() {
  const btn = $('#dmLoginBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/dreamina/login', { method: 'POST' });
    if (!r.ok) {
      toast('发起登录失败：' + (r.message || r.reason || '未知原因'), 'err');
      return;
    }
    dmState.deviceCode = r.device_code;
    dmState.tries = 0;
    $('#dmLoginBox').hidden = false;
    $('#dmAuthUrl').textContent = r.verification_uri || '';
    $('#dmUserCode').textContent = r.user_code ? `user_code：${r.user_code}` : '';
    $('#dmLoginMsg').textContent = r.expires_at ? `授权码有效期至 ${r.expires_at}` : '等待授权…';
    pollDreaminaLogin();
  } catch (e) {
    toast('发起登录失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/** 轮询 checklogin：单次内部最长等待 30s，故此处仅作少量重试（合计约 10 分钟窗口） */
function pollDreaminaLogin() {
  clearTimeout(dmState.timer);
  dmState.timer = setTimeout(async () => {
    if (!dmState.deviceCode) return;
    dmState.tries += 1;
    if (dmState.tries > 20) {
      $('#dmLoginMsg').textContent = '授权码可能已过期，请重新点击「登录即梦」';
      dmState.deviceCode = null;
      return;
    }
    try {
      const r = await api('/api/dreamina/login/check', {
        method: 'POST',
        body: { device_code: dmState.deviceCode, poll: 30 },
      });
      if (r.ok) {
        toast(`即梦登录成功（可用积分 ${r.total_credit ?? '?'}）`, 'ok');
        dmState.deviceCode = null;
        $('#dmLoginBox').hidden = true;
        await loadDreaminaStatus(true);
        return;
      }
      $('#dmLoginMsg').textContent = r.message || '等待授权…';
    } catch (e) {
      $('#dmLoginMsg').textContent = '检查失败：' + e.message;
    }
    pollDreaminaLogin();
  }, 2000);
}

/** 退出即梦登录 */
async function doDreaminaLogout() {
  try {
    await api('/api/dreamina/logout', { method: 'POST' });
    toast('已退出即梦登录', 'ok');
    await loadDreaminaStatus(true);
  } catch (e) {
    toast('退出失败：' + e.message, 'err');
  }
}

/** 装配设置弹窗交互（顶栏 ⚙ 打开 / 保存按钮 / 即梦独立操作） */
function initSettings() {
  $('#btnSettings').addEventListener('click', () => {
    // 清理上一轮登录轮询，避免多次打开叠加
    clearTimeout(dmState.timer);
    dmState.deviceCode = null;
    loadSettings();
    $('#settingsModal').hidden = false;
  });
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  // 智谱启用开关：即时联动整块提示（真正的写入仍在「保存设置」时提交）
  $('#setZpEnabled').addEventListener('change', renderZhipuState);
  // 即梦 CLI：三个即时操作（不经过「保存设置」）
  $('#dmRefreshBtn').addEventListener('click', () => loadDreaminaStatus(true));
  $('#dmLoginBtn').addEventListener('click', startDreaminaLogin);
  $('#dmLogoutBtn').addEventListener('click', doDreaminaLogout);
}

export { renderConn, loadSettings, initSettings };
