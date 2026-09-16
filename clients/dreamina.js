'use strict';
/**
 * dreamina.js —— 即梦官方 CLI（dreamina）客户端
 *
 * 与 agnes.js 对称：同为「上游客户端」，区别是传输层为「本地子进程」而非 HTTP。
 * 官方 CLI 仅限即梦会员使用，登录态由 CLI 自行保管（~/.dreamina_cli），本模块只读不写凭证。
 *
 * 为什么必须经本模块 spawn 包装，而不是各 worker 自行调用：
 *   1) 防 stdin 阻塞 —— login/relogin 默认「打印授权信息后等待授权完成」，若继承 stdin 会永久挂起。
 *      与 ffmpeg 的 `Overwrite? [y/N]` 属同类事故（见 AGENTS.md 渲染永久卡死），故一律 stdio:[ignore,pipe,pipe]。
 *   2) 统一 JSON 解析 —— 实测 user_credit / list_task / text2video / query_result 均输出 JSON。
 *   3) 统一超时与错误分类（未登录 / 未安装 / 参数错误 / 业务失败）。
 *
 * 实测要点（v1.4.18）：
 *   - submit_id 为 UUID；gen_status 取值 querying / success / fail
 *   - 提交返回 queue_info 可观测排队（实测 queue_length 达数十万，完成时间可能很长）
 *   - 登录授权码有效期约 10 分钟（expires_at），过期须重新 login --headless
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 60_000;
// 提交与查询为异步语义（提交即返回，轮询另起），正常应秒级返回；--poll 会延长等待
const SUBMIT_TIMEOUT_MS = 90_000;
const LOGIN_TIMEOUT_MS = 30_000;

/** 即梦视频子命令（与 CLI 的 generator commands 对齐） */
const VIDEO_SUBCOMMANDS = ['text2video', 'image2video', 'frames2video', 'multiframe2video', 'multimodal2video'];

/** 定位 dreamina 可执行文件：环境变量 > 常见安装位置 > 交给 PATH 解析 */
function resolveBin() {
  const explicit = String(process.env.DREAMINA_CLI_PATH || '').trim();
  if (explicit) return explicit;
  const exe = process.platform === 'win32' ? 'dreamina.exe' : 'dreamina';
  const candidates = [
    path.join(os.homedir(), 'bin', exe), // 官方安装脚本在 Windows 的默认落点
    path.join(os.homedir(), '.local', 'bin', exe), // macOS / Linux 默认落点
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略探测异常，退回 PATH */
    }
  }
  return exe;
}

/** 从 stderr/stdout 文本归类错误（CLI 的失败提示为纯文本，与 JSON 成功路径区分） */
function classify(code, stdout, stderr) {
  const text = `${stderr}\n${stdout}`;
  if (/未检测到有效登录态|请先执行\s*dreamina login/.test(text)) return 'not-logged-in';
  if (/AigcComplianceConfirmationRequired/i.test(text)) return 'need-web-confirm';
  if (/required flag|unknown flag|unsupported|invalid|not set/i.test(text)) return 'bad-args';
  if (code === null) return 'timeout';
  return 'cli-error';
}

/**
 * 执行 dreamina 子命令（永不抛错，返回结果对象供调用方翻译）
 * @param {string[]} args 子命令与参数（spawn 数组形式，不经过 shell，故无需转义）
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, code: number|null, data: object|null, stdout: string,
 *                    stderr: string, error: string|null, kind: string|null}>}
 */
function run(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const bin = resolveBin();
    let child;
    try {
      child = spawn(bin, args, {
        // 关键：stdin 置 ignore，杜绝 CLI 等待输入导致的永久挂起（对标 runFfmpeg 的 -nostdin）
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        ok: false,
        code: null,
        data: null,
        stdout: '',
        stderr: '',
        error: `无法启动 dreamina CLI（${bin}）：${e.message}`,
        kind: 'not-installed',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    child.on('error', (e) => {
      const notInstalled = e.code === 'ENOENT';
      finish({
        ok: false,
        code: null,
        data: null,
        stdout,
        stderr,
        error: notInstalled
          ? `未找到 dreamina CLI（${bin}），请先安装：curl -fsSL https://jimeng.jianying.com/cli | bash`
          : e.message,
        kind: notInstalled ? 'not-installed' : 'spawn-error',
      });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish({
          ok: false,
          code: null,
          data: null,
          stdout: stdout.slice(0, 4000),
          stderr: stderr.slice(0, 4000),
          error: `dreamina ${args[0]} 执行超时（${Math.round(timeoutMs / 1000)}s）`,
          kind: 'timeout',
        });
        return;
      }
      const out = stdout.trim();
      let data = null;
      if (out) {
        try {
          data = JSON.parse(out);
        } catch {
          data = null; // 非 JSON 输出（错误提示等）
        }
      }
      const ok = code === 0 && data !== null;
      finish({
        ok,
        code,
        data,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        error: ok
          ? null
          : String(stderr || stdout || '')
              .trim()
              .slice(0, 500) || null,
        kind: ok ? null : classify(code, stdout, stderr),
      });
    });
  });
}

/** 组装视频生成参数 → argv（CLI 的 --kebab 参数接受 `--k=v` 形式） */
function buildVideoArgs(params = {}) {
  const {
    subcommand = 'text2video',
    prompt,
    duration,
    ratio,
    videoResolution,
    modelVersion,
    session,
    poll,
    image,
    first,
    last,
    images,
    video,
    audio,
  } = params;
  if (!VIDEO_SUBCOMMANDS.includes(subcommand)) throw new Error(`不支持的即梦视频子命令：${subcommand}`);

  const args = [subcommand];
  // 注意：--video_resolution 为 CLI 必填，缺失会以 bad-args 失败
  if (videoResolution) args.push(`--video_resolution=${videoResolution}`);
  if (prompt) args.push(`--prompt=${prompt}`);
  if (duration) args.push(`--duration=${duration}`);
  if (ratio) args.push(`--ratio=${ratio}`);
  if (modelVersion) args.push(`--model_version=${modelVersion}`);
  if (session !== undefined && session !== null) args.push(`--session=${session}`);
  if (poll) args.push(`--poll=${poll}`);
  if (image) args.push(`--image=${image}`);
  if (first) args.push(`--first=${first}`);
  if (last) args.push(`--last=${last}`);
  if (images) args.push(`--images=${Array.isArray(images) ? images.join(',') : images}`);
  // multimodal2video（全能参考）：可同时传入参考视频与参考音频
  if (video) args.push(`--video=${Array.isArray(video) ? video.join(',') : video}`);
  if (audio) args.push(`--audio=${Array.isArray(audio) ? audio.join(',') : audio}`);
  return args;
}

/** 即梦图片子命令：text2image（文生图）/ image2image（图生图，参考图经 --images 传入） */
const IMAGE_SUBCOMMANDS = ['text2image', 'image2image'];

/** 组装图片生成参数 → argv（--resolution_type 为 CLI 必填；--width/--height 与 --ratio 互斥） */
function buildImageArgs(params = {}) {
  const {
    subcommand = 'text2image',
    prompt,
    ratio,
    resolutionType,
    modelVersion,
    generateNum,
    width,
    height,
    images,
    session,
    poll,
  } = params;
  if (!IMAGE_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(`不支持的即梦图片子命令：${subcommand}`);
  }

  const args = [subcommand];
  if (resolutionType) args.push(`--resolution_type=${resolutionType}`);
  if (prompt) args.push(`--prompt=${prompt}`);
  if (ratio) args.push(`--ratio=${ratio}`);
  if (modelVersion) args.push(`--model_version=${modelVersion}`);
  if (generateNum) args.push(`--generate_num=${generateNum}`);
  // CLI 规定 width/height 必须成对出现（单给会被拒）
  if (width && height) args.push(`--width=${width}`, `--height=${height}`);
  // image2image 的参考图（本地路径或 URL，多张用逗号连接）
  if (images) args.push(`--images=${Array.isArray(images) ? images.join(',') : images}`);
  if (session !== undefined && session !== null) args.push(`--session=${session}`);
  if (poll) args.push(`--poll=${poll}`);
  return args;
}

/**
 * 从 query_result 响应中提取图片地址。
 * 即梦成功响应的确切字段名尚未实测固化，故兼容多种可能形态（数组字段 / 单字段 / data 内嵌）；
 * 解析失败时由调用方保留原始响应（last_poll_response），便于按真实字段名补充。
 */
function extractImageUrls(j) {
  const urls = [];
  const push = (u) => {
    const s = typeof u === 'string' ? u.trim() : '';
    if (/^https?:\/\//i.test(s)) urls.push(s);
  };
  for (const key of ['image_urls', 'images', 'urls']) {
    if (Array.isArray(j?.[key])) j[key].forEach((x) => push(typeof x === 'string' ? x : x?.url));
  }
  push(j?.image_url || j?.url || j?.metadata?.url);
  if (j?.data) {
    if (Array.isArray(j.data.images)) {
      j.data.images.forEach((x) => push(typeof x === 'string' ? x : x?.url));
    }
    push(j.data.image_url || j.data.url);
  }
  return [...new Set(urls)];
}

const dreamina = {
  resolveBin,
  run,
  buildVideoArgs,
  buildImageArgs,
  extractImageUrls,
  VIDEO_SUBCOMMANDS,
  IMAGE_SUBCOMMANDS,

  /** 提交视频生成任务（异步）：返回 { submit_id, gen_status, credit_count, queue_info, ... } */
  async submitVideo(params) {
    const args = buildVideoArgs(params);
    return run(args, { timeoutMs: SUBMIT_TIMEOUT_MS });
  },

  /** 提交图片生成任务（异步）：返回 { submit_id, gen_status, credit_count, ... } */
  async submitImage(params) {
    const args = buildImageArgs(params);
    return run(args, { timeoutMs: SUBMIT_TIMEOUT_MS });
  },

  /** 查询异步任务结果：query_result --submit_id=<uuid>（加 downloadDir 可让 CLI 直接落盘） */
  async queryResult({ submitId, downloadDir }) {
    const args = ['query_result', `--submit_id=${submitId}`];
    if (downloadDir) args.push(`--download_dir=${downloadDir}`);
    return run(args);
  },

  /** 账户积分与 VIP 级别：{ total_credit, user_id, vip_level, ... } */
  async credit() {
    return run(['user_credit'], { timeoutMs: 30_000 });
  },

  /** 本地已保存任务列表（JSON 数组） */
  async listTask({ limit = 20, offset = 0, genStatus, submitId } = {}) {
    const args = ['list_task', `--limit=${limit}`, `--offset=${offset}`];
    if (genStatus) args.push(`--gen_status=${genStatus}`);
    if (submitId) args.push(`--submit_id=${submitId}`);
    return run(args, { timeoutMs: 30_000 });
  },

  /**
   * 发起无头登录：打印 verification_uri / user_code / device_code 后立即退出（不等待授权）。
   * 配合 checkLogin 收尾，可避免阻塞事件循环。
   */
  async loginHeadless() {
    return run(['login', '--headless'], { timeoutMs: LOGIN_TIMEOUT_MS });
  },

  /** 收尾登录：轮询至授权完成（poll 为最长等待秒数） */
  async checkLogin({ deviceCode, poll = 30 }) {
    const args = ['login', 'checklogin', `--device_code=${deviceCode}`];
    if (poll) args.push(`--poll=${poll}`);
    // 等待时间由 poll 决定，超时留出余量
    return run(args, { timeoutMs: (Number(poll) || 30) * 1000 + 20_000 });
  },

  /** 清除本地 OAuth 登录态 */
  async logout() {
    return run(['logout'], { timeoutMs: 30_000 });
  },

  /** CLI 版本信息（JSON） */
  async version() {
    return run(['version'], { timeoutMs: 15_000 });
  },
};

module.exports = dreamina;
