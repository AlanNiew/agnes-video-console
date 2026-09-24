'use strict';
/**
 * core/provider-policy.js —— 多上游「可用性 / 回退」策略（**纯函数，零副作用**）
 *
 * 规则来源（用户口径 + 台账《幻灯屋》§七）：
 *   **会过期的即梦额度先用；但积分不足 / 生成失败 / 非 VIP / 环境未就绪 → 一律回退免费档（Agnes），不阻塞制作。**
 *
 * 本模块只做判断，不执行任何动作、不 require 业务模块：
 *   - `dreaminaUsable()`            提交前的环境可用性（装了吗 / 登录了吗 / 是 VIP 吗）
 *   - `shouldFallbackFromDreamina()` 运行期失败后是否改投免费档（按 dreamina.classify 的 kind）
 * 具体「改投」动作由 workers（submitter / image-worker）与装配层执行，见 workers/*.js。
 */
const { MODELS, IMAGE_MODEL, DREAMINA_DAILY_BUDGET_DEFAULT } = require('./constants');

/** 预算上限非法时的回落值（与 core/constants 的默认值同源，避免两处漂移） */
const DAILY_BUDGET_DEFAULT = DREAMINA_DAILY_BUDGET_DEFAULT;

/** 回退目标：免费档（Agnes）模型 */
const FREE_VIDEO_MODEL = 'agnes-video-2.5-flash';
const FREE_IMAGE_MODEL = IMAGE_MODEL;

/** Agnes 2.5 家族约束（回退映射时钳制用） */
const FREE_VIDEO_SIZES = MODELS[FREE_VIDEO_MODEL].sizes; // ['720P']
const FREE_VIDEO_MAX_SECONDS = 12;
const FREE_VIDEO_MIN_SECONDS = 4;

/** 即梦 `user_credit` 返回的 vip_level 白名单（standard = 标准会员，已可用图片/普通视频档） */
const VIP_LEVELS = ['standard', 'vip', 'svip', 'annual', 'premium', 'blackgold'];

/** 该 vip_level 是否算「有 VIP」（空 / none / 未知一律按无 VIP 处理，走回退更安全） */
function isVipLevel(level) {
  return VIP_LEVELS.includes(
    String(level || '')
      .trim()
      .toLowerCase(),
  );
}

/**
 * 提交前判定即梦是否可用（不可用即直接用免费档，不提交、不扣分）。
 *
 * @param {{installed?:boolean, loggedIn?:boolean, vipLevel?:string, enabled?:boolean}} o
 *        enabled=false 表示设置项 `dreamina_auto_character`/总开关关闭
 * @returns {{usable:boolean, reason:string|null}} reason ∈ disabled|not-installed|not-logged-in|not-vip
 */
function dreaminaUsable(o = {}) {
  if (o.enabled === false) return { usable: false, reason: 'disabled' };
  if (!o.installed) return { usable: false, reason: 'not-installed' };
  if (!o.loggedIn) return { usable: false, reason: 'not-logged-in' };
  if (!isVipLevel(o.vipLevel)) return { usable: false, reason: 'not-vip' };
  return { usable: true, reason: null };
}

/**
 * 运行期失败后是否改投免费档。
 *
 * kind 取自 `clients/dreamina.classify()`：
 *   not-installed / not-logged-in / need-web-confirm / bad-args / cli-error / timeout / spawn-error / login-failed
 *
 * 分类：
 *   - **立即回退**（重试无意义或按规则不该等）：环境未就绪、合规闸门、参数错、CLI 业务错（含积分不足）
 *   - **先重试**（瞬时网络/进程问题）：timeout / spawn-error —— 达到 maxAttempts 后再回退
 *   - `enabled=false` 时永不回退（保留旧的「退避等人工处理」行为，供设置项关闭时使用）
 *
 * @param {string} kind
 * @param {{attempts?:number, maxAttempts?:number, enabled?:boolean}} [o]
 * @returns {{fallback:boolean, reason:string|null, retry:boolean}}
 */
function shouldFallbackFromDreamina(kind, o = {}) {
  const enabled = o.enabled !== false;
  const attempts = Number(o.attempts) || 1;
  const maxAttempts = Number(o.maxAttempts) || 3;
  const k = String(kind || 'cli-error');

  if (!enabled) return { fallback: false, reason: null, retry: true };
  if (k === 'timeout' || k === 'spawn-error') {
    // 瞬时错误：先退避重试，超过上限仍失败 → 回退，避免无限等待
    return attempts >= maxAttempts
      ? { fallback: true, reason: k, retry: false }
      : { fallback: false, reason: null, retry: true };
  }
  // 环境 / 合规 / 参数 / 业务错误：回退（其中 need-web-confirm 按台账 §七 规则 4「不等它」）
  return { fallback: true, reason: k, retry: false };
}

/**
 * v2.6.7 **反向回退**：Agnes 任务提交失败后是否改投即梦（`seedance2.0mini`）。
 *
 * 与 `shouldFallbackFromDreamina` 方向相反：那边是"即梦不行→免费档"，这边是"免费档排队排不上→即梦"。
 * 设置项 `dreamina_agnes_fallback`（默认 **关**：会消耗会员积分，须显式开启）。
 *
 * 只对**重试也大概率无效**的失败启用（否则会白白消耗积分）：
 *   - `queue-full` 上游队列长时间满（503 queue_full，实测 flash 连续 22 分钟排不上）
 *   - `rate-limit` 429 限流重试耗尽
 *   - `net`        网络异常重试耗尽
 * **内容/参数类失败（4xx 非 429）不改投** —— 即梦同样会拒，改了只是花钱。
 *
 * @param {string} kind queue-full | rate-limit | net | 其它
 * @param {{enabled?:boolean}} [o]
 * @returns {{fallback:boolean, reason:string|null}}
 */
function shouldFallbackToDreamina(kind, o = {}) {
  if (o.enabled === false) return { fallback: false, reason: null };
  const k = String(kind || '');
  if (k === 'queue-full' || k === 'rate-limit' || k === 'net') return { fallback: true, reason: k };
  return { fallback: false, reason: null };
}

/** 把任意秒数钳制到免费档可接受的整数秒（4–12） */
function clampFreeSeconds(seconds) {
  const n = Math.round(Number(seconds) || 5);
  return Math.min(Math.max(n, FREE_VIDEO_MIN_SECONDS), FREE_VIDEO_MAX_SECONDS);
}

/** 免费档视频分辨率：Flash 仅支持 720P，其它取值一律落到 720P */
function freeVideoSize(size) {
  const s = String(size || '').trim();
  return FREE_VIDEO_SIZES.includes(s) ? s : FREE_VIDEO_SIZES[0];
}

/** 回退原因 → 中文说明（日志 / 任务备注统一措辞） */
const FALLBACK_REASON_TEXT = {
  disabled: '即梦开关已关闭',
  'not-installed': '未安装 dreamina CLI',
  'not-logged-in': '即梦未登录',
  'not-vip': '即梦账户无 VIP 权益',
  'insufficient-credit': '即梦积分不足',
  'need-web-confirm': '即梦合规闸门（需先在 Web 端生成一次）',
  'bad-args': '即梦不接受该参数组合',
  'cli-error': '即梦 CLI 业务错误',
  'gen-failed': '即梦生成失败',
  'no-result': '即梦未产出可用结果',
  timeout: '即梦生成超时',
  'spawn-error': '即梦进程异常',
  'login-failed': '即梦登录失效',
};

function fallbackReasonText(reason) {
  return FALLBACK_REASON_TEXT[reason] || `即梦不可用（${reason}）`;
}

/** v2.6.7 反向回退（Agnes → 即梦）的原因 → 中文说明 */
const TO_DREAMINA_REASON_TEXT = {
  'queue-full': 'Agnes 免费档队列长时间满（503）',
  'rate-limit': 'Agnes 提交限流（429）重试耗尽',
  net: 'Agnes 提交网络异常重试耗尽',
  'no-prompt': '任务缺少提示词',
  'too-many-reference-images': '参考图数量超出目标即梦模型上限（明确报错，不静默丢图）',
  'unknown-model': '目标即梦模型不在白名单',
  'unsupported-subcommand': '目标即梦模型不支持文生视频',
  'bad-args': '参数无法映射为即梦合法入参',
  'dreamina-unusable': '即梦不可用（未安装 / 未登录 / 无权益）',
  'insufficient-credit': '即梦积分不足',
};

function toDreaminaReasonText(reason) {
  return TO_DREAMINA_REASON_TEXT[reason] || `无法改投即梦（${reason}）`;
}

/**
 * v2.6.10 即梦**每日预算闸门**（纯函数，便于单测）。
 *
 * 为什么要它：账号约束是**每天最多 100 积分**，而 `user_credit` 只报跨天总余额
 * （今天花光了余额仍可能 >100），不设闸门的话「自动兜底 + 自动角色图」会在无人值守时
 * 一天烧掉几百积分。判据是**当日累计记账**，与余额护栏互补：
 *   - 余额护栏（`dreaminaUsable` + 提交处）：防"余额不足还去提交"；
 *   - 预算闸门（本函数）：防"余额充足但今天已超配额"。
 *
 * @param {{cap?:number, spentToday?:number, estimate?:number|null}} o
 *        cap=0 表示不限；spentToday=当日已提交记账（分）；estimate=本次预估（分，null=未知→放行）
 * @returns {{allowed:boolean, reason:'daily-budget-exhausted'|'unknown-estimate'|null, spentToday:number, cap:number}}
 */
function dreaminaBudgetAllows(o = {}) {
  const cap = Number(o.cap);
  const spentToday = Number(o.spentToday) || 0;
  const estimate = o.estimate == null ? null : Number(o.estimate);
  // ⚠ cap 非法（NaN/负数）必须回落到**默认上限**，不能当"不限"——
  // 那是危险方向：一条坏配置就会把 100/天的硬约束整个放开。真正的"不限"只有显式的 0。
  const realCap = !Number.isFinite(cap) || cap < 0 ? DAILY_BUDGET_DEFAULT : cap;
  if (realCap <= 0) {
    return { allowed: true, reason: null, spentToday, cap: 0 };
  }
  if (estimate != null && !Number.isFinite(estimate)) {
    return { allowed: true, reason: 'unknown-estimate', spentToday, cap: realCap };
  }
  // estimate 未知（如少数未标定的规格）时保守**拦截**：预算是硬约束，
  // 宁可少一次自动兜底也不要超支。
  if (estimate == null) {
    return { allowed: false, reason: 'unknown-estimate', spentToday, cap: realCap };
  }
  if (spentToday + estimate > realCap) {
    return { allowed: false, reason: 'daily-budget-exhausted', spentToday, cap: realCap };
  }
  return { allowed: true, reason: null, spentToday, cap: realCap };
}

/** 预算闸门的原因 → 中文说明（与 toDreaminaReasonText 同风格） */
function budgetReasonText(reason, ctx = {}) {
  if (reason === 'daily-budget-exhausted') {
    return `即梦当日积分预算已用尽（${ctx.spentToday ?? '?'}/${ctx.cap ?? '?'}，本次约需 ${ctx.estimate ?? '?'}）`;
  }
  if (reason === 'unknown-estimate') {
    return '无法预估本次即梦消耗（超出当日积分预算的把握）';
  }
  return `即梦预算闸门：${reason || '放行'}`;
}

/**
 * v2.6.11 自动兜底的**每日镜数配额**（纯函数）。
 *
 * 用户口径：「只在必要镜头用即梦」—— 自动兜底不能把一集里所有卡住的镜头都换成即梦（30 积分/镜），
 * 否则一天 100 积分的预算会被 3 镜吃光。故自动路径每天最多救 N 镜（默认 2），
 * 其余镜头**留给用户手动一键「⬆ 升级即梦」**决定 —— 花钱的最终裁量权在人手里。
 * 手动升级不受此配额限制（仅受每日积分预算约束）。
 *
 * @param {{cap?:number, usedToday?:number}} o cap=0 表示不限制自动兜底镜数
 * @returns {{allowed:boolean, usedToday:number, cap:number}}
 */
function dreaminaAutoQuotaAllows(o = {}) {
  const cap = Number(o.cap);
  const usedToday = Number(o.usedToday) || 0;
  const realCap = !Number.isFinite(cap) || cap < 0 ? 0 : cap;
  if (realCap <= 0) return { allowed: true, usedToday, cap: 0 };
  return { allowed: usedToday < realCap, usedToday, cap: realCap };
}

module.exports = {
  FREE_VIDEO_MODEL,
  FREE_IMAGE_MODEL,
  FREE_VIDEO_SIZES,
  VIP_LEVELS,
  isVipLevel,
  dreaminaUsable,
  shouldFallbackFromDreamina,
  shouldFallbackToDreamina,
  clampFreeSeconds,
  freeVideoSize,
  fallbackReasonText,
  toDreaminaReasonText,
  dreaminaBudgetAllows,
  budgetReasonText,
  dreaminaAutoQuotaAllows,
};
