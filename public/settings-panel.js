/* settings-panel.js —— 设置弹窗 + 顶栏连接状态（M4-B2：自 app.js 拆出）
 * 负责：GET/PUT /api/settings、TTS 音色（Fish Audio）与 BGM（音乐接口）配置读写；
 * renderConn 供 task-center 在任务刷新失败/恢复时更新顶栏连接提示。
 * 依赖：common.js、task-meta.js（模型下拉与旧模型兜底）。
 */
import { $, esc, toast, api } from './common.js';
import { selectableModels, DEFAULT_MODEL, onModelChange } from './task-meta.js';

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
    // 旧模型兜底：设置里的默认模型若已下架，则回退默认免费模型
    const m = selectableModels().some((x) => x.id === settingsState.settings.model)
      ? settingsState.settings.model
      : DEFAULT_MODEL();
    $('#fModel').value = m;
    onModelChange();
    $('#setModel').value = m; // 设置弹窗同样做旧模型兜底，避免静默不选中
    $('#setBaseUrl').value = settingsState.settings.base_url;
    $('#setPollMs').value = settingsState.settings.poll_interval_ms;
    $('#setMaxMin').value = settingsState.settings.max_active_minutes;
    $('#setSubmitMs').value = settingsState.settings.submit_interval_ms ?? 60000;
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
      model: $('#setModel').value,
      poll_interval_ms: Number($('#setPollMs').value),
      max_active_minutes: Number($('#setMaxMin').value),
      submit_interval_ms: Number($('#setSubmitMs').value),
    };
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
    await api('/api/settings', { method: 'PUT', body });
    toast('设置已保存', 'ok');
    $('#settingsModal').hidden = true;
    $('#setApiKey').value = '';
    $('#setFishKey').value = '';
    $('#setMusicToken').value = '';
    await loadSettings();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/** 装配设置弹窗交互（顶栏 ⚙ 打开 / 保存按钮） */
function initSettings() {
  $('#btnSettings').addEventListener('click', () => {
    loadSettings();
    $('#settingsModal').hidden = false;
  });
  $('#btnSaveSettings').addEventListener('click', saveSettings);
}

export { renderConn, loadSettings, initSettings };
