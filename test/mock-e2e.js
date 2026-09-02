'use strict';
/**
 * mock-e2e.js —— 端到端冒烟测试
 * 1. 启动一个模拟 Agnes API 的本地假服务器（POST /v1/videos + GET /agnesapi）
 * 2. 以独立端口/独立数据库启动本控制台
 * 3. 创建任务 → 等待轮询 → 断言任务走到 completed 且拿到 metadata.url
 * 运行：npm run test:mock
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const MOCK_PORT = 8392;
const APP_PORT = 8391;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const DATA_DIR_ROOT = path.join(__dirname, '..', 'data');
const TEST_DB = path.join(DATA_DIR_ROOT, 'e2e-test.db');
const TEST_ARTIFACTS = path.join(DATA_DIR_ROOT, 'e2e-artifacts'); // 测试专用 artifacts 目录，不污染生产 data/artifacts

/* ---------------- 模拟 Agnes API ---------------- */
const mockJobs = new Map(); // video_id -> job
let seq = 0;
let rateLimitRemaining = 0; // v1.3：429 模拟计数器（>0 时 POST /v1/videos 返回 429）
let fixtureFile = null; // v1.3：真实渲染 e2e 用的可解码测试视频（有 ffmpeg 时生成）
let bgmFixture = null; // v1.4：BGM 渲染用的可解码测试音频（有 ffmpeg 时生成）

function mockResult(job) {
  const completed = job.status === 'completed';
  return {
    id: job.task_id,
    task_id: job.task_id,
    video_id: job.video_id,
    object: 'video',
    model: job.model,
    status: job.status,
    progress: job.progress,
    created_at: job.created_at,
    completed_at: job.status === 'completed' ? Date.now() : null,
    seconds: job.seconds,
    size: job.size,
    // 模拟真实接口：完成时只返回顶层 url（无 metadata 对象），验证控制台的 url 回退逻辑
    metadata: null,
    url: completed ? `http://127.0.0.1:${MOCK_PORT}/out/mock-${job.video_id}.mp4` : null,
    error: job.status === 'failed' ? { message: job.error } : null,
  };
}

const mockServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  const send = (code, obj) => {
    // Connection: close —— 消灭 keep-alive 连接复用竞态（undici 池中的死连接会让
    // worker 的 fetch 反复挂到 headers 超时，表现为轮询停摆数分钟）
    res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'POST' && u.pathname === '/v1/videos') {
    // v1.3：429 限流模拟（由 /__mock/ratelimit 控制剩余次数）
    if (rateLimitRemaining > 0) {
      rateLimitRemaining -= 1;
      return send(429, { detail: 'video generation rate limit exceeded: allows 1 requests per 1 minute(s)' });
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    if (!body.prompt) return send(400, { detail: 'prompt is required' });
    seq += 1;
    const job = {
      video_id: `video_mock_${seq}`,
      task_id: `task_mock_${seq}`,
      model: body.model,
      seconds: body.seconds,
      size: body.size,
      status: 'pending', // 模拟真实接口：创建后先处于 pending（排队等待）
      progress: 0,
      created_at: Date.now(),
      polls: 0,
    };
    mockJobs.set(job.video_id, job);
    return send(200, mockResult(job));
  }

  // v1.4：BGM 音频文件（须在下方 /out/ 前缀分支之前精确匹配：
  // 否则会命中视频兜底分支，无 ffmpeg 时只返回 12 字节 mp4 header，
  // 导致 downloadBGM 报「BGM 下载数据异常（过小）」）
  if (req.method === 'GET' && u.pathname === '/out/bgm.mp3') {
    const buf = bgmFixture && fs.existsSync(bgmFixture) ? fs.readFileSync(bgmFixture) : Buffer.alloc(4096, 7);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length });
    return res.end(buf);
  }

  // v1.3：模拟完成的视频文件（供本地归档下载与成片渲染 e2e；有 ffmpeg 时返回可解码的真实测试视频）
  if (req.method === 'GET' && u.pathname.startsWith('/out/')) {
    if (fixtureFile && fs.existsSync(fixtureFile)) {
      const buf = fs.readFileSync(fixtureFile);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
      return res.end(buf);
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]));
    return;
  }

  // v1.3：429 模拟开关 {count: N} —— 之后 N 次 POST /v1/videos 返回 429
  if (req.method === 'POST' && u.pathname === '/__mock/ratelimit') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    rateLimitRemaining = Math.max(0, Number(body.count) || 0);
    return send(200, { ok: true, rateLimitRemaining });
  }

  // v1.4：模拟音乐接口（BGM）
  if (req.method === 'GET' && u.pathname === '/search') {
    return send(200, {
      code: 200,
      message: 'success',
      data: [
        {
          music_id: 12345,
          music_name: '测试曲',
          artist: '测试歌手',
          album: '测试专辑',
          duration: 180,
          pic_url: '',
          levels: [{ level: 'standard' }, { level: 'exhigh' }],
        },
      ],
    });
  }
  if (req.method === 'GET' && u.pathname === '/player') {
    return send(200, { code: 200, message: 'success', data: { url: `http://127.0.0.1:${MOCK_PORT}/out/bgm.mp3` } });
  }

  if (req.method === 'GET' && u.pathname === '/agnesapi') {
    const videoId = u.searchParams.get('video_id');
    const job = mockJobs.get(videoId);
    if (!job) return send(404, { detail: 'video not found' });
    job.polls += 1;
    if (job.status === 'pending' && job.polls === 1) {
      // 第一次轮询仍为 pending → 控制台应将其映射为 queued 继续轮询，而非误判失败
    } else if (job.status === 'pending' && job.polls >= 2) {
      job.status = 'in_progress';
      job.progress = 40;
    } else if (job.status === 'in_progress' && job.polls >= 3) {
      job.status = 'completed';
      job.progress = 100;
    }
    return send(200, mockResult(job));
  }

  // 模拟文本模型 /v1/chat/completions
  // 分派依据结构化契约而非具体措辞：文案生成的 system 必须要求「JSON 对象」输出（这是
  // 控制台解析逻辑的依赖契约），提示词优化则以「优化」关键词识别，其余走通用回复
  if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const sys = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    let content;
    if (sys.includes('"shot_seq"')) {
      // P3 L1 分镜自审契约（system 要求输出 issues 数组，含 shot_seq 字段）
      content = JSON.stringify({
        issues: [
          {
            shot_seq: 1,
            severity: 'low',
            field: 'narration',
            issue: '旁白与画面内容重复，缺少推进感',
            revised: '暮色拉长了土路，夏天走成了脚印。',
          },
          {
            shot_seq: 2,
            severity: 'high',
            field: 'video_prompt',
            issue: '动作量超出该镜时长承载',
            revised:
              '以 <Picture 1> 中的角色为参考，保持其外观一致。低机位特写黄胶鞋踏过土路，麦浪拂过镜头下沿，暖金色逆光，脚步声由远及近。',
          },
        ],
        overall: '整体节奏完整，一处旁白可优化、一处动作量偏大',
      });
    } else if (sys.includes('"shots"')) {
      // M2 分镜生成契约（system 中要求输出 shots 数组）
      content = JSON.stringify({
        shots: [
          {
            seq: 1,
            title: '开场：麦田远景',
            video_prompt:
              '以 <Picture 1> 中的角色为参考，保持其外观一致。黄昏麦田大全景，少年背影走向远方，镜头缓慢推进，暖金色逆光，风声与自然环境声',
            narration: '黄昏麦田起伏，少年走在土路上。',
            seconds: '5',
          },
          {
            seq: 2,
            title: '近景：脚步与麦浪',
            video_prompt:
              '以 <Picture 1> 中的角色为参考，保持其外观一致。低机位特写黄胶鞋踏过土路，麦浪拂过镜头，暖金色逆光，脚步声与麦浪沙沙声',
            narration: '他数着自己的脚步，像数着一整个夏天。',
            seconds: '6',
          },
        ],
      });
    } else if (sys.includes('JSON 对象')) {
      content = JSON.stringify({
        script: '测试梗概：夏日黄昏，穿黄胶鞋的少年沿着麦田土路走向远方，镜头跟随他的背影，暖金色逆光，宁静而怀念。',
        video_prompt:
          '以 <Picture 1> 中的角色为参考，保持其外观一致。少年沿麦田土路走向远方，麦浪随风起伏，暖金色逆光，镜头缓慢横摇，电影写实风格，自然环境声',
        character_desc: '十五岁少年，黑色短发，穿旧蓝白校服与黄色胶鞋，清瘦，腼腆，电影写实',
        scene_desc: '黄昏麦田土路，麦浪起伏，暖金色逆光，天边晚霞',
      });
    } else if (sys.includes('优化')) {
      content =
        '雨后的未来城市街道，霓虹灯倒映在湿漉漉的地面，一辆银色跑车缓缓驶过，镜头缓慢横摇跟随，电影级写实风格，自然环境声，高细节';
    } else {
      content = '（mock）通用文本回复';
    }
    return send(200, {
      choices: [{ message: { role: 'assistant', content } }],
      model: body.model || 'agnes-2.5-flash',
    });
  }

  // 模拟图片模型 /v1/images/generations（返回 CDN URL；prompt 含 FAIL_IMAGE 时模拟上游 400 不可恢复错误）
  if (req.method === 'POST' && u.pathname === '/v1/images/generations') {
    let imgRaw = '';
    for await (const chunk of req) imgRaw += chunk;
    const imgBody = JSON.parse(imgRaw || '{}');
    if (String(imgBody.prompt || '').includes('FAIL_IMAGE')) {
      return send(400, { error: { message: 'mock image upstream bad request' } });
    }
    seq += 1;
    const url = `http://127.0.0.1:${MOCK_PORT}/out/img-mock-${seq}.png`;
    return send(200, { created: Date.now(), data: [{ url, b64_json: null, revised_prompt: null }] });
  }

  // 模拟生成结果图片（供本地备份下载；Connection:close 防止 keep-alive 死连接竞态）
  if (req.method === 'GET' && u.pathname.startsWith('/out/')) {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    res.writeHead(200, { 'Content-Type': 'image/png', Connection: 'close' });
    return res.end(png);
  }

  send(404, { detail: 'not found' });
});

/* ---------------- 工具 ---------------- */
const err = (msg) => {
  console.error('\n✗ FAIL: ' + msg);
  process.exit(1);
};
const ok = (msg) => console.log('  ✓ ' + msg);

async function api(method, p, body) {
  const res = await fetch(APP_BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** v1.3：设置 mock 上游的 429 计数器（注意：该端点在 mock 服务器上，不是应用服务器） */
async function mockRateLimit(count) {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/ratelimit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  return res.json();
}

/** v1.3：等待后台提交器把任务提交到上游（拿到 video_id 或进入失败终态） */
async function waitSubmitted(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let t = null;
  while (Date.now() < deadline) {
    t = (await api('GET', `/api/tasks/${id}`)).data;
    if (t?.video_id || ['failed', 'submit_error'].includes(t?.status)) return t;
    await sleep(300);
  }
  return t;
}

/** v1.3：等待任务完成（渲染素材就绪） */
async function waitCompleted(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let t = null;
  while (Date.now() < deadline) {
    t = (await api('GET', `/api/tasks/${id}`)).data;
    if (['completed', 'failed', 'submit_error'].includes(t?.status)) return t;
    await sleep(400);
  }
  return t;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  console.log('== Agnes Video 任务控制台 端到端冒烟测试 ==');
  try {
    fs.rmSync(TEST_DB, { force: true });
    fs.rmSync(TEST_DB + '-wal', { force: true });
    fs.rmSync(TEST_DB + '-shm', { force: true });
    // 失败运行的产物残留会在下次运行触发 ffmpeg「Overwrite? [y/N]」死等（同名封面文件）——启动即清空
    fs.rmSync(TEST_ARTIFACTS, { recursive: true, force: true });
  } catch {}

  // 启动 Mock Agnes API
  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  console.log(`[mock] Agnes API 模拟服务器已启动于 :${MOCK_PORT}`);

  // v1.3：有 ffmpeg 时生成可解码的测试视频（成片渲染 e2e 用；无 ffmpeg 则归档测试用伪字节）
  try {
    const { spawnSync } = require('node:child_process');
    fixtureFile = path.join(DATA_DIR_ROOT, 'e2e-fixture.mp4');
    const ff = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=15:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        fixtureFile,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (ff.status !== 0 || !fs.existsSync(fixtureFile)) fixtureFile = null;
    // v1.4：BGM 测试音频（真实 mp3，供渲染混音）
    if (fixtureFile) {
      bgmFixture = path.join(DATA_DIR_ROOT, 'e2e-bgm.mp3');
      const fb = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=220:duration=6',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '64k',
          bgmFixture,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      if (fb.status !== 0 || !fs.existsSync(bgmFixture)) bgmFixture = null;
    }
  } catch {
    fixtureFile = null;
  }

  // 配置并启动控制台（独立端口 + 独立数据库 + 独立 artifacts 目录）
  process.env.PORT = String(APP_PORT);
  process.env.DB_PATH = TEST_DB;
  process.env.DATA_DIR = TEST_ARTIFACTS;
  process.env.SUBMIT_RATE_LIMIT_BASE_MS = '500'; // v1.3：加速 429 退避（默认 60s 对齐真实免费档）
  require('../server');
  // 轮询等待就绪（取代固定 sleep，消除慢机器/CI 上首检 ECONNREFUSED 的 flaky）
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(APP_BASE + '/api/health')).ok;
    } catch {
      await sleep(200);
    }
  }
  if (!up) err('控制台未能在 10 秒内完成启动');
  console.log(`[app] 控制台已启动于 :${APP_PORT}`);

  // 1. 健康检查
  const health = await api('GET', '/api/health');
  if (!health.data?.ok) err('健康检查失败');
  ok('健康检查 /api/health');

  // 2. 设置（指向 mock + 假 key；提交间隔设小以加速测试，同时验证服务端节流参数生效）
  const set = await api('PUT', '/api/settings', {
    api_key: 'sk-test-key-1234',
    base_url: `http://127.0.0.1:${MOCK_PORT}`,
    poll_interval_ms: 500,
    max_active_minutes: 1,
    submit_interval_ms: 300,
    fish_api_key: 'sk-fish-test-0000', // 仅用于校验层测试（本测试不会真正调用 Fish 合成）
    // v1.4 BGM：音乐接口指向 mock
    music_api_base: `http://127.0.0.1:${MOCK_PORT}`,
    music_api_token: 'tok-music-test-0000',
    music_level: 'exhigh',
  });
  if (set.status !== 200) err('保存设置失败');
  ok('保存设置（base_url→mock）');

  // 3. 掩码校验：key 不出现在设置响应中
  const st = await api('GET', '/api/settings');
  if (st.data.api_key_masked !== 'sk-t****1234') err(`API Key 掩码异常: ${JSON.stringify(st.data.api_key_masked)}`);
  if (JSON.stringify(st.data).includes('sk-test-key-1234')) err('API Key 泄露到设置响应');
  if (JSON.stringify(st.data).includes('tok-music-test-0000')) err('音乐 Token 泄露到设置响应');
  ok('API Key / 音乐 Token 仅以掩码或布尔返回，未泄露');

  // 3.1 设置校验：非法模型 / 轮询间隔越界 → 400
  const setBad1 = await api('PUT', '/api/settings', { model: 'agnes-video-9.9' });
  if (setBad1.status !== 400 || !String(setBad1.data.error).includes('不支持的模型')) {
    err(`非法模型未被正确拦截: ${JSON.stringify(setBad1.data)}`);
  }
  const setBad2 = await api('PUT', '/api/settings', { poll_interval_ms: 100 });
  if (setBad2.status !== 400 || !String(setBad2.data.error).includes('poll_interval_ms')) {
    err(`轮询间隔越界未被正确拦截: ${JSON.stringify(setBad2.data)}`);
  }
  ok('校验：设置非法 model / poll_interval_ms 被 400 拒绝（含错误信息）');

  // 3.2 元数据端点：前端下拉的单一事实来源
  const meta = await api('GET', '/api/meta');
  if (meta.status !== 200 || !Array.isArray(meta.data.models) || meta.data.models.length < 2) {
    err(`/api/meta 模型清单异常: ${JSON.stringify(meta.data).slice(0, 200)}`);
  }
  if (!meta.data.models.some((m) => m.id === 'agnes-video-2.5-flash' && m.free && !m.deprecated)) {
    err('/api/meta 缺少默认免费模型 agnes-video-2.5-flash');
  }
  if (!meta.data.aspect_ratios.includes('16:9') || !meta.data.seconds.includes('5')) {
    err('/api/meta 画幅/时长清单异常');
  }
  if (!Array.isArray(meta.data.image?.ratios) || meta.data.image.ratios.length < 5) {
    err('/api/meta 图片比例清单异常');
  }
  // v1.3：上游限流提示随 meta 下发
  const flashMeta = meta.data.models.find((m) => m.id === 'agnes-video-2.5-flash');
  if (!flashMeta?.rate_limit) err('meta 缺少 flash 模型的 rate_limit 限流提示');
  ok('元数据 /api/meta：模型/画幅/时长/图片清单完整（含限流提示）');

  // 3.3 v1.3：API 自描述
  const oas = await api('GET', '/api/openapi.json');
  if (
    oas.status !== 200 ||
    !oas.data.paths?.['/api/tasks']?.post ||
    !oas.data.paths?.['/api/projects/{id}/render']?.post ||
    !oas.data.paths?.['/api/tts/generate']?.post
  ) {
    err('openapi.json 缺少关键端点描述');
  }
  if (!String(oas.data.info?.description || '').includes('入队')) err('openapi 描述未说明入队语义');
  ok('/api/openapi.json 自描述：任务入队/成片渲染/配音端点齐全');

  // 4. 创建 text 任务
  const created = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash',
    prompt: '雨后的未来城市街道，霓虹灯倒映在地面，一辆银色跑车缓慢驶过，电影级运镜',
    mode: 'text',
    seconds: '5',
    size: '720P',
    aspect_ratio: '16:9',
  });
  if (created.status !== 201) err(`创建任务失败: ${JSON.stringify(created)}`);
  const taskId = created.data.id;
  // v1.3：提交异步化 —— 创建仅入队（无 video_id），由后台提交器节流提交
  if (created.data.video_id) err('任务刚创建就携带 video_id（提交应异步由提交器完成）');
  const sub1 = await waitSubmitted(taskId);
  if (!sub1?.video_id) err(`提交器未在期限内完成任务提交: ${JSON.stringify(sub1?.status)}`);
  if (!sub1.submitted_at) err('提交成功但缺少 submitted_at');
  ok(`已创建任务 #${taskId}，提交器异步提交成功 video_id=${sub1.video_id}`);

  // 4.1 列表接口回归：任务必须出现在 /api/tasks 列表中（防止占位符参数 bug 回归）
  const list = await api('GET', '/api/tasks?limit=200');
  if (!list.data?.items?.some((x) => x.id === taskId)) {
    err(`任务 #${taskId} 未出现在列表接口中（列表返回 ${list.data?.items?.length || 0} 条）`);
  }
  ok(`列表接口正常（items=${list.data.items.length}，含 #${taskId}）`);

  // 5. 等待轮询闭环：queued → in_progress → completed
  let final = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const r = await api('GET', `/api/tasks/${taskId}`);
    final = r.data;
    if (final.status === 'completed' || final.status === 'failed') break;
  }
  if (!final || final.status !== 'completed') err(`任务未按预期完成，最终状态: ${JSON.stringify(final?.status)}`);
  if (!final.metadata_url) err('completed 但缺少 metadata_url');
  // pending 兜底 + 两次推进：至少轮询 3 次（pending → in_progress → completed）
  if (final.poll_count < 3) err(`轮询次数异常: ${final.poll_count}`);
  ok(
    `轮询闭环完成：${final.status} @ ${final.progress}%，轮询 ${final.poll_count} 次（含 pending 状态兜底），视频: ${final.metadata_url}`,
  );

  // 5.1 v1.3 本地归档：完成后自动下载到 artifacts（远端链接过期也有本地兜底）
  let archived = null;
  const dArch = Date.now() + 15_000;
  while (Date.now() < dArch) {
    archived = (await api('GET', `/api/tasks/${taskId}`)).data;
    if (archived.video_local_url) break;
    await sleep(400);
  }
  if (!archived?.video_local_url) err('完成任务未自动归档本地视频（video_local_url 缺失）');
  if (!fs.existsSync(archived.video_local_path)) err(`归档文件不存在: ${archived.video_local_path}`);
  ok(`本地归档：${path.basename(archived.video_local_path)}（播放/下载优先本地）`);

  // 5.2 v1.3 提交队列：连续 429 后自动退避重试，最终提交成功（不再产生 submit_error 死记录）
  await mockRateLimit(2);
  const rl = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash',
    prompt: '限流重试测试：雨夜霓虹街道空镜',
    mode: 'text',
    seconds: '5',
  });
  if (rl.status !== 201) err(`429 测试任务创建失败: ${JSON.stringify(rl.data)}`);
  const rlSub = await waitSubmitted(rl.data.id, 30_000);
  if (!rlSub?.video_id) err(`429 后未自动重试成功，最终状态: ${rlSub?.status} / ${rlSub?.error_message}`);
  ok('提交队列：连续 2 次 429 被自动退避重试并成功提交');

  // 5.3 v1.3 提交队列：服务端按 submit_interval_ms 节流（测试配置 300ms）
  const a1 = await api('POST', '/api/tasks', { model: 'agnes-video-2.5-flash', prompt: '间隔测试A', mode: 'text' });
  const a2 = await api('POST', '/api/tasks', { model: 'agnes-video-2.5-flash', prompt: '间隔测试B', mode: 'text' });
  const s1 = await waitSubmitted(a1.data.id, 30_000);
  const s2 = await waitSubmitted(a2.data.id, 30_000);
  if (!s1?.submitted_at || !s2?.submitted_at) err('间隔测试任务未成功提交');
  const gap = Math.abs(s2.submitted_at - s1.submitted_at);
  if (gap < 250) err(`服务端提交间隔未生效（两次提交相差 ${gap}ms，配置为 300ms）`);
  ok(`服务端提交节流生效（两次提交间隔 ${gap}ms ≥ 配置 300ms）`);

  // 6. 校验规则：text 模式带媒体 → 400
  const bad1 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash',
    prompt: 'x',
    mode: 'text',
    images: ['https://example.com/a.png'],
  });
  if (bad1.status !== 400 || !String(bad1.data.error).includes('text 模式'))
    err(`text 模式携带图片未被拦截: ${JSON.stringify(bad1.data)}`);
  ok('校验：text 模式携带媒体被 400 拒绝（含错误信息）');

  // 7. 校验规则：flash + 视频参考 → 400
  const bad2 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash',
    prompt: 'x',
    mode: 'reference',
    videos: ['https://example.com/a.mp4'],
  });
  if (bad2.status !== 400 || !String(bad2.data.error).includes('videos'))
    err(`flash 视频参考未被拦截: ${JSON.stringify(bad2.data)}`);
  ok('校验：Flash 模型 videos 被 400 拒绝（含错误信息）');

  // 8. 校验规则：reference 无素材 → 400
  const bad3 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash',
    prompt: 'x',
    mode: 'reference',
  });
  if (bad3.status !== 400) err('reference 无素材未被拦截');
  ok('校验：reference 模式无素材被 400 拒绝');

  // 8.1 通用文本生成 /api/llm/chat：happy path + 输入校验
  const chat = await api('POST', '/api/llm/chat', {
    system: '你是视频生成提示词优化器。把用户的想法优化为结构化中文提示词。',
    messages: [{ role: 'user', content: '银色跑车驶过雨后街道' }],
    temperature: 0.8,
  });
  if (chat.status !== 200 || !chat.data.content) err(`llm/chat 失败: ${JSON.stringify(chat.data).slice(0, 300)}`);
  ok(`llm/chat 生成成功（${String(chat.data.content).slice(0, 24)}…）`);

  const chatBad = async (body, keyword) => {
    const r = await api('POST', '/api/llm/chat', body);
    if (r.status !== 400 || !String(r.data.error).includes(keyword)) {
      err(`llm/chat 校验失效（期望 400 含「${keyword}」）: ${JSON.stringify(r.data)}`);
    }
  };
  await chatBad({ messages: [] }, 'messages');
  await chatBad({ messages: [{ role: 'hacker', content: 'x' }] }, 'role');
  await chatBad({ messages: [{ role: 'user', content: '' }] }, 'content');
  await chatBad({ messages: [{ role: 'user', content: 'x' }], temperature: 9 }, 'temperature');
  await chatBad({ messages: [{ role: 'user', content: 'x' }], max_tokens: 99999 }, 'max_tokens');
  await chatBad({ messages: [{ role: 'user', content: 'x' }], model: 'agnes-video-2.5' }, '暂只支持文本模型');
  ok('校验：llm/chat 非法 messages/role/temperature/max_tokens/model 全部被 400 拒绝');

  // 9. V2.0：文生视频
  const v2a = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0',
    prompt: 'cat walking on the beach at sunset',
    mode: 'text',
    num_frames: 121,
    frame_rate: 24,
    width: 1280,
    height: 720,
  });
  if (v2a.status !== 201) err(`V2.0 文生创建失败: ${JSON.stringify(v2a.data)}`);
  const rqa = v2a.data.request_json;
  if (rqa.num_frames !== 121 || rqa.frame_rate !== 24 || rqa.image || rqa.extra_body) {
    err(`V2.0 文生 payload 异常: ${JSON.stringify(rqa)}`);
  }
  if (v2a.data.size !== '1280x720' || v2a.data.aspect_ratio !== '16:9') {
    err(`V2.0 尺寸/画幅计算异常: ${v2a.data.size}/${v2a.data.aspect_ratio}`);
  }
  ok(
    `V2.0 文生创建成功 #${v2a.data.id}（size=${v2a.data.size}，aspect=${v2a.data.aspect_ratio}，seconds=${v2a.data.seconds}）`,
  );

  // 10. V2.0：图生视频
  const v2b = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0',
    prompt: 'animate the character with subtle breathing',
    mode: 'image',
    num_frames: 81,
    frame_rate: 24,
    width: 720,
    height: 720,
    image: 'https://example.com/char.png',
  });
  if (v2b.status !== 201) err(`V2.0 图生创建失败: ${JSON.stringify(v2b.data)}`);
  if (v2b.data.request_json.image !== 'https://example.com/char.png') err('V2.0 图生 payload 缺 image');
  ok(`V2.0 图生创建成功 #${v2b.data.id}（含 image URL）`);

  // 11. V2.0：关键帧动画（extra_body）
  const v2c = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0',
    prompt: 'smooth transition between keyframes',
    mode: 'keyframes',
    num_frames: 121,
    frame_rate: 24,
    images: ['https://example.com/kf1.png', 'https://example.com/kf2.png'],
  });
  if (v2c.status !== 201) err(`V2.0 关键帧创建失败: ${JSON.stringify(v2c.data)}`);
  const eb = v2c.data.request_json.extra_body;
  if (!eb || eb.mode !== 'keyframes' || eb.image?.length !== 2) {
    err(`V2.0 关键帧 payload 异常: ${JSON.stringify(v2c.data.request_json)}`);
  }
  ok(`V2.0 关键帧创建成功 #${v2c.data.id}（extra_body.mode=keyframes，${eb.image.length} 张）`);

  // 12. V2.0 校验：num_frames 不满足 8n+1 → 400
  const badV2 = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0',
    prompt: 'x',
    mode: 'text',
    num_frames: 100,
  });
  if (badV2.status !== 400) err('num_frames=100 未被拦截');
  ok('校验：V2.0 num_frames 不满足 8n+1 被 400 拒绝');

  // 13. V2.0 校验：关键帧少于 2 张 → 400
  const badV2b = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0',
    prompt: 'x',
    mode: 'keyframes',
    num_frames: 121,
    images: ['https://example.com/kf1.png'],
  });
  if (badV2b.status !== 400) err('关键帧 1 张未被拦截');
  ok('校验：V2.0 关键帧少于 2 张被 400 拒绝');

  // 14. V2.0 校验：图生缺 image → 400
  const badV2c = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0',
    prompt: 'x',
    mode: 'image',
    num_frames: 121,
  });
  if (badV2c.status !== 400) err('图生缺 image 未被拦截');
  ok('校验：V2.0 图生视频缺 image 被 400 拒绝');

  // 15. V2.0 轮询闭环（等待完成）
  let v2final = null;
  const d2 = Date.now() + 20_000;
  while (Date.now() < d2) {
    await sleep(500);
    const r = await api('GET', `/api/tasks/${v2a.data.id}`);
    v2final = r.data;
    if (v2final.status === 'completed' || v2final.status === 'failed') break;
  }
  if (!v2final || v2final.status !== 'completed') err(`V2.0 任务未完成: ${JSON.stringify(v2final?.status)}`);
  if (!v2final.metadata_url) err('V2.0 完成但缺 metadata_url');
  ok(`V2.0 轮询闭环完成（轮询 ${v2final.poll_count} 次，视频: ${v2final.metadata_url}）`);

  // ================= 流水线全链路（创意→文案→角色图→视频） =================
  // 16. 创建项目
  const proj = await api('POST', '/api/projects', {
    name: '黄昏麦田少年',
    idea: '黄昏麦田，穿黄胶鞋的少年走向远方',
    style: '电影写实',
    aspect_ratio: '16:9',
    seconds: '8',
  });
  if (proj.status !== 201 || !proj.data.id) err(`创建项目失败: ${JSON.stringify(proj.data)}`);
  const pid = proj.data.id;
  ok(`创建项目 #${pid}（${proj.data.name}）`);

  // 17. 文案生成（文本模型 → 结构化 JSON 落库）
  const scr = await api('POST', '/api/llm/script', {
    idea: '黄昏麦田少年走向远方',
    style: '电影写实',
    aspect_ratio: '16:9',
    seconds: '8',
    project_id: pid,
  });
  if (scr.status !== 200 || !scr.data.parsed) err(`文案生成失败: ${JSON.stringify(scr.data).slice(0, 300)}`);
  if (!scr.data.result?.video_prompt || !scr.data.result?.character_desc) err('文案缺少 video_prompt/character_desc');
  {
    const d = await api('GET', `/api/projects/${pid}`);
    const kinds = d.data.texts.map((t) => t.kind).sort();
    if (!['character_desc', 'scene_desc', 'script', 'video_prompt'].every((k) => kinds.includes(k))) {
      err(`文案未按 4 个 kind 落库: ${kinds.join(',')}`);
    }
  }
  ok('文案生成：4 类文案结构化输出并落库');

  // 17.1 项目列表接口
  const projList = await api('GET', '/api/projects');
  if (projList.status !== 200 || !projList.data.items?.some((x) => x.id === pid)) err('项目列表未包含新项目');
  ok(`项目列表正常（items=${projList.data.items.length}）`);

  // 17.2 项目校验：空名称 / 非法画幅 → 400
  const pBad1 = await api('POST', '/api/projects', { name: '', idea: 'x' });
  if (pBad1.status !== 400 || !String(pBad1.data.error).includes('名称'))
    err(`项目空名称未被拦截: ${JSON.stringify(pBad1.data)}`);
  const pBad2 = await api('POST', '/api/projects', { name: 'x', aspect_ratio: '7:3' });
  if (pBad2.status !== 400 || !String(pBad2.data.error).includes('aspect_ratio'))
    err(`项目非法画幅未被拦截: ${JSON.stringify(pBad2.data)}`);
  ok('校验：项目空名称 / 非法画幅被 400 拒绝');

  // 17.3 文案编辑 + 版本选用
  const texts1 = (await api('GET', `/api/projects/${pid}`)).data.texts;
  const vp = texts1.find((t) => t.kind === 'video_prompt');
  const patchT = await api('PATCH', `/api/projects/${pid}/texts/${vp.id}`, { content: vp.content + '（手动微调）' });
  if (patchT.status !== 200 || !patchT.data.ok) err(`编辑文案失败: ${JSON.stringify(patchT.data)}`);
  const afterPatch = (await api('GET', `/api/projects/${pid}`)).data.texts.find((t) => t.id === vp.id);
  if (!afterPatch.content.endsWith('（手动微调）')) err('文案编辑未生效');
  const selT = await api('POST', `/api/projects/${pid}/select-text`, { text_id: vp.id });
  if (selT.status !== 200 || !selT.data.ok) err(`选用文案失败: ${JSON.stringify(selT.data)}`);
  ok(`文案编辑与版本选用正常（text #${vp.id}）`);

  // 17.4 跨项目越权编辑（IDOR）→ 404：用另一项目的 URL 编辑本项目文案
  const proj2 = await api('POST', '/api/projects', { name: '干扰项目', idea: 'x' });
  if (proj2.status !== 201) err('创建第二个项目失败');
  const idor = await api('PATCH', `/api/projects/${proj2.data.id}/texts/${vp.id}`, { content: '恶意篡改' });
  if (idor.status !== 404) err(`跨项目文案编辑未被拦截（期望 404）: ${JSON.stringify(idor.data)}`);
  const idorSel = await api('POST', `/api/projects/${proj2.data.id}/select-text`, { text_id: vp.id });
  if (idorSel.status !== 404) err('跨项目文案选用未被拦截（期望 404）');
  ok('校验：跨项目编辑/选用文案被 404 拒绝（归属校验）');

  // 17.5 项目 PATCH：正常更新 + 非法 status / 空 name → 400
  const pPatch = await api('PATCH', `/api/projects/${pid}`, { name: '黄昏麦田少年（改）', seconds: '10' });
  if (pPatch.status !== 200 || pPatch.data.name !== '黄昏麦田少年（改）' || pPatch.data.seconds !== '10') {
    err(`项目 PATCH 异常: ${JSON.stringify(pPatch.data)}`);
  }
  const pBad3 = await api('PATCH', `/api/projects/${pid}`, { status: 'hacked' });
  if (pBad3.status !== 400 || !String(pBad3.data.error).includes('status'))
    err(`非法 status 未被拦截: ${JSON.stringify(pBad3.data)}`);
  const pBad4 = await api('PATCH', `/api/projects/${pid}`, { name: '   ' });
  if (pBad4.status !== 400) err('空名称 PATCH 未被拦截');
  ok('项目 PATCH：正常更新生效，非法 status / 空 name 被 400 拒绝');

  // 17.6 分镜生成（M2）：storyboard 文本版本落库 + shots 工作副本重建
  const sb = await api('POST', '/api/llm/storyboard', {
    idea: '黄昏麦田少年走向远方',
    style: '电影写实',
    shot_count: '2',
    aspect_ratio: '16:9',
    seconds: '5',
    project_id: pid,
  });
  if (sb.status !== 200 || !sb.data.parsed) err(`分镜生成失败: ${JSON.stringify(sb.data).slice(0, 300)}`);
  if (!Array.isArray(sb.data.shots) || sb.data.shots.length !== 2)
    err(`分镜镜头数异常: ${JSON.stringify(sb.data.shots)?.length}`);
  if (!sb.data.shots[0].video_prompt.includes('<Picture 1>')) err('分镜提示词未包含 <Picture 1> 角色引用');
  const sbDetail = await api('GET', `/api/projects/${pid}`);
  const shotsPid = sbDetail.data.shots;
  if (shotsPid.length !== 2 || shotsPid.map((s) => s.seq).join(',') !== '1,2')
    err(`shots 工作副本异常: ${JSON.stringify(shotsPid)}`);
  const sbText = sbDetail.data.texts.find((t) => t.kind === 'storyboard');
  if (!sbText?.selected) err('storyboard 文本版本未落库或未选中');
  // v1.3：分镜旁白随 LLM 输出落库；引用开关默认开启
  if (!shotsPid[0].narration) err('分镜 narration 旁白未落库');
  if (shotsPid.some((s) => s.use_character_ref !== 1)) err('use_character_ref 默认值应为 1（引用角色图）');
  ok('分镜生成：storyboard 版本落库 + 2 个镜头工作副本按 seq 重建（含旁白）');

  // 17.7 镜头 CRUD / 排序 / 校验 / 跨项目越权
  const addShot = await api('POST', `/api/projects/${pid}/shots`, {
    title: '手动补充镜头',
    video_prompt: '以 <Picture 1> 中的角色为参考，保持其外观一致。手动补充的第三个镜头',
    seconds: '6',
  });
  if (addShot.status !== 201 || addShot.data.seq !== 3) err(`手动加镜头失败: ${JSON.stringify(addShot.data)}`);
  const patchShot = await api('PATCH', `/api/projects/${pid}/shots/${addShot.data.id}`, {
    title: '手动镜头（改）',
    seconds: '7',
  });
  if (patchShot.status !== 200 || patchShot.data.title !== '手动镜头（改）' || patchShot.data.seconds !== '7') {
    err(`镜头 PATCH 异常: ${JSON.stringify(patchShot.data)}`);
  }
  const shotEmpty = await api('POST', `/api/projects/${pid}/shots`, { video_prompt: '   ' });
  if (shotEmpty.status !== 400) err('空提示词镜头未被 400 拦截');
  const reorder = await api('POST', `/api/projects/${pid}/shots/reorder`, {
    ids: [addShot.data.id, shotsPid[1].id, shotsPid[0].id],
  });
  if (reorder.status !== 200 || reorder.data.shots.map((s) => s.seq).join(',') !== '1,2,3') {
    err(`镜头排序异常: ${JSON.stringify(reorder.data)}`);
  }
  const reorderBad = await api('POST', `/api/projects/${pid}/shots/reorder`, { ids: [addShot.data.id] });
  if (reorderBad.status !== 400) err('不完整的 ids 排序未被 400 拦截');
  const shotIdor = await api('PATCH', `/api/projects/${proj2.data.id}/shots/${addShot.data.id}`, { title: 'x' });
  if (shotIdor.status !== 404) err('跨项目镜头编辑未被 404 拦截');
  const delShot = await api('DELETE', `/api/projects/${pid}/shots/${addShot.data.id}`);
  if (delShot.status !== 200) err(`删除镜头失败: ${JSON.stringify(delShot.data)}`);
  const delShotAgain = await api('DELETE', `/api/projects/${pid}/shots/${addShot.data.id}`);
  if (delShotAgain.status !== 404) err('重复删除镜头未被 404 拒绝');
  ok('镜头 CRUD：新增/PATCH/排序/删除正常，空提示词与跨项目越权被拦截');

  // 17.8 分镜重新生成：覆盖工作副本（新镜头 id），storyboard 版本累计
  const oldShotIds = shotsPid.map((s) => s.id);
  const sb2 = await api('POST', '/api/llm/storyboard', {
    idea: '黄昏麦田少年走向远方（改）',
    project_id: pid,
  });
  if (sb2.status !== 200 || !sb2.data.parsed || sb2.data.shots.length !== 2) {
    err(`分镜重新生成异常: ${JSON.stringify(sb2.data).slice(0, 200)}`);
  }
  const sbDetail2 = await api('GET', `/api/projects/${pid}`);
  const sbVersions = sbDetail2.data.texts.filter((t) => t.kind === 'storyboard');
  if (sbVersions.length !== 2) err(`storyboard 版本数异常: ${sbVersions.length}`);
  if (sbDetail2.data.shots.length !== 2) err('重新生成后镜头数未更新');
  if (sbDetail2.data.shots.some((s) => oldShotIds.includes(s.id))) err('重新生成后镜头 id 未更换（工作副本未重建）');
  ok('分镜重新生成：工作副本重建（新镜头 id），storyboard 版本累计 2 版');

  // 17.9 选用历史 storyboard 版本 → 重建镜头工作副本
  const v1 = sbVersions.find((t) => !t.selected) || sbVersions[0];
  const applySb = await api('POST', `/api/projects/${pid}/storyboard/apply`, { text_id: v1.id });
  if (
    applySb.status !== 200 ||
    !applySb.data.ok ||
    !Array.isArray(applySb.data.shots) ||
    applySb.data.shots.length !== 2
  ) {
    err(`选用历史版本异常: ${JSON.stringify(applySb.data).slice(0, 200)}`);
  }
  const apply404 = await api('POST', `/api/projects/${pid}/storyboard/apply`, { text_id: 999999 });
  if (apply404.status !== 404) err('选用不存在的 storyboard 版本未被 404 拦截');
  const applyIdor = await api('POST', `/api/projects/${proj2.data.id}/storyboard/apply`, { text_id: v1.id });
  if (applyIdor.status !== 404) err('跨项目选用 storyboard 未被 404 拦截');
  ok('选用历史分镜版本：镜头重建 + 404 拦截（不存在 / 跨项目）');

  // 17.10 storyboard 参数校验：空 idea / 项目不存在
  const sbBad1 = await api('POST', '/api/llm/storyboard', { idea: '' });
  if (sbBad1.status !== 400) err('storyboard 空 idea 未被 400 拦截');
  const sbBad2 = await api('POST', '/api/llm/storyboard', { idea: 'x', project_id: 999999 });
  if (sbBad2.status !== 404) err('storyboard 项目不存在未被 404 拦截');
  ok('校验：storyboard 空 idea 400 / 项目不存在 404');

  // 17.11 批量提交间隔设置：默认值、修改、非法值
  // v1.3：默认值已在测试开头改为 300（加速提交队列），此处验证读取/修改/越界拦截；
  // 服务端提交器与前端批量提交共用这一参数
  const st0 = await api('GET', '/api/settings');
  if (st0.data.submit_interval_ms !== 300) err(`submit_interval_ms 读取异常: ${st0.data.submit_interval_ms}`);
  const st1 = await api('PUT', '/api/settings', { submit_interval_ms: 5000 });
  if (st1.status !== 200) err('保存 submit_interval_ms 失败');
  const st2 = await api('GET', '/api/settings');
  if (st2.data.submit_interval_ms !== 5000) err('submit_interval_ms 修改未生效');
  const stBad1 = await api('PUT', '/api/settings', { submit_interval_ms: -1 });
  if (stBad1.status !== 400) err('submit_interval_ms 负数未被 400 拦截');
  const stBad2 = await api('PUT', '/api/settings', { submit_interval_ms: 999999 });
  if (stBad2.status !== 400) err('submit_interval_ms 超上限未被 400 拦截');
  await api('PUT', '/api/settings', { submit_interval_ms: 300 }); // 还原测试快速值，避免影响后续
  ok('设置：submit_interval_ms 读取/修改生效/越界 400 拦截（服务端提交节流同源）');

  // 17.12 文案 auto_select=false：新版只落库不选中（前端对比窗决策模式）
  const scr2 = await api('POST', '/api/llm/script', {
    idea: '黄昏麦田少年走向远方',
    style: '电影写实',
    aspect_ratio: '16:9',
    seconds: '8',
    project_id: pid,
    auto_select: false,
  });
  if (scr2.status !== 200 || !scr2.data.parsed)
    err(`auto_select=false 文案生成失败: ${JSON.stringify(scr2.data).slice(0, 200)}`);
  if (!scr2.data.previous?.script?.content) err('auto_select=false 未返回 previous 旧内容');
  if (!scr2.data.new_text_ids?.script) err('auto_select=false 未返回 new_text_ids');
  {
    const d = (await api('GET', `/api/projects/${pid}`)).data;
    const selScript = d.texts.find((t) => t.kind === 'script' && t.selected);
    const newScript = d.texts.find((t) => t.id === scr2.data.new_text_ids.script);
    if (!selScript || selScript.id === scr2.data.new_text_ids.script) err('auto_select=false 时旧版本应保持选中');
    if (!newScript || newScript.selected) err('auto_select=false 时新版本应为未选中状态');
  }
  ok('文案 auto_select=false：旧版本保持选中，新版仅落库并回传 previous/new_text_ids');

  // 17.13 分镜 auto_select=false：shots 不变 + 新版本未选中；apply 后采用
  const shotsBeforeSb = (await api('GET', `/api/projects/${pid}`)).data.shots.map((s) => s.id);
  const sb3 = await api('POST', '/api/llm/storyboard', {
    idea: '黄昏麦田少年走向远方',
    project_id: pid,
    auto_select: false,
  });
  if (sb3.status !== 200 || !sb3.data.parsed)
    err(`auto_select=false 分镜生成失败: ${JSON.stringify(sb3.data).slice(0, 200)}`);
  if (sb3.data.auto_selected !== false || !sb3.data.text_id) err('auto_select=false 分镜响应异常');
  if (JSON.stringify(sb3.data.current_shots.map((s) => s.id)) !== JSON.stringify(shotsBeforeSb))
    err('auto_select=false 不应重建 shots');
  const applySb2 = await api('POST', `/api/projects/${pid}/storyboard/apply`, { text_id: sb3.data.text_id });
  if (applySb2.status !== 200 || applySb2.data.shots.some((s) => shotsBeforeSb.includes(s.id))) {
    err('apply 采用新版本后 shots 未重建');
  }
  ok('分镜 auto_select=false：shots 保持不变，apply 采用后重建为新镜头');

  // 17.14 图片 count=3：一次三张候选，全部落库，首张自动选中
  const imgMulti = await api('POST', '/api/images/generate', {
    prompt: '角色立绘：多张候选测试',
    size: '1K',
    ratio: '1:1',
    project_id: pid,
    kind: 'character',
    count: 3,
  });
  if (imgMulti.status !== 200) err(`count=3 图片生成失败: ${JSON.stringify(imgMulti.data).slice(0, 200)}`);
  if (!Array.isArray(imgMulti.data.results) || imgMulti.data.results.length !== 3)
    err(`count=3 应返回 3 张: ${imgMulti.data.results?.length}`);
  if (imgMulti.data.failed !== 0) err(`count=3 不应有失败: ${imgMulti.data.failed}`);
  if (!imgMulti.data.image?.selected) err('count 多张时首张应自动选中');
  if (imgMulti.data.remote_url !== imgMulti.data.results[0].remote_url) err('首张字段与 results[0] 不一致');
  const imgsAfterMulti = (await api('GET', `/api/projects/${pid}`)).data.images.filter((x) => x.kind === 'character');
  if (imgsAfterMulti.length < 3) err(`count=3 落库异常: ${imgsAfterMulti.length}`);
  ok('图片 count=3：一次生成 3 张候选并全部落库，首张自动选中（兼容首张字段）');

  // 17.15 P1：异步图片任务（独立创作）—— 入队 → image worker 生成 → 任务中心统一可见
  const imgTask = await api('POST', '/api/images/tasks', {
    prompt: '独立图片创作：雪山日出',
    size: '1K',
    ratio: '16:9',
    count: 2,
  });
  if (imgTask.status !== 201) err(`图片任务创建失败: ${JSON.stringify(imgTask.data).slice(0, 200)}`);
  if (imgTask.data.kind !== 'image' || imgTask.data.status !== 'queued')
    err(`图片任务初始状态错误: kind=${imgTask.data.kind} status=${imgTask.data.status}`);
  const imgTaskId = imgTask.data.id;
  let imgDone = null;
  const imgDl = Date.now() + 20_000;
  while (Date.now() < imgDl) {
    await sleep(500);
    imgDone = (await api('GET', `/api/tasks/${imgTaskId}`)).data;
    if (imgDone.status === 'completed' || imgDone.status === 'failed') break;
  }
  if (!imgDone || imgDone.status !== 'completed') err(`独立图片任务未完成: ${JSON.stringify(imgDone?.status)}`);
  if (!Array.isArray(imgDone.images) || imgDone.images.length !== 2)
    err(`独立图片任务应有 2 张产物: ${imgDone.images?.length}`);
  if (!imgDone.images[0]?.remote_url) err('图片产物缺少 remote_url');
  if (!imgDone.video_local_url) err('图片产物未本地归档（首张 video_local_url 缺失）');
  const listWithImg = await api('GET', '/api/tasks?limit=20');
  const inList = listWithImg.data.items.find((x) => x.id === imgTaskId);
  if (!inList || inList.kind !== 'image') err('图片任务未出现在列表接口或 kind 字段缺失');
  if (typeof listWithImg.data.total !== 'number') err('列表接口缺少 total 字段（P0 分页）');
  ok(`异步图片任务 #${imgTaskId} 完成（2 张产物 · 本地归档 · 列表 kind=image 可见 · total=${listWithImg.data.total}）`);

  // 17.16 P1：挂项目的图片任务 —— 完成后落 project_images 并首张自动定稿
  const imgsBefore = ((await api('GET', `/api/projects/${pid}`)).data.images || []).length;
  const imgTask2 = await api('POST', '/api/images/tasks', {
    prompt: '项目角色图（异步）：红发少女',
    size: '1K',
    ratio: '1:1',
    project_id: pid,
    kind: 'character',
    count: 1,
  });
  if (imgTask2.status !== 201) err(`项目图片任务创建失败: ${JSON.stringify(imgTask2.data).slice(0, 200)}`);
  let imgDone2 = null;
  const imgDl2 = Date.now() + 20_000;
  while (Date.now() < imgDl2) {
    await sleep(500);
    imgDone2 = (await api('GET', `/api/tasks/${imgTask2.data.id}`)).data;
    if (imgDone2.status === 'completed' || imgDone2.status === 'failed') break;
  }
  if (imgDone2?.status !== 'completed') err(`项目图片任务未完成: ${imgDone2?.status}`);
  const imgsAfterTask = (await api('GET', `/api/projects/${pid}`)).data.images;
  if (imgsAfterTask.length <= imgsBefore) err('项目图片任务完成后未落 project_images');
  const linked = imgsAfterTask.find((x) => x.id === imgDone2.images?.[0]?.image_id);
  if (!linked) err('图片任务产物未关联 project_images 记录（image_id 缺失）');
  if (!linked?.selected) err('项目图片任务首张未自动定稿');
  ok(`项目图片任务 #${imgTask2.data.id} 完成并落库定稿 #${linked.id}`);

  // 17.16a v2.1：任务来源上下文（列表/详情直接给出项目名、镜头序号标题、图片类型）
  {
    const projNameNow = ((await api('GET', `/api/projects/${pid}`)).data.project || {}).name;
    const detailCtx = (await api('GET', `/api/tasks/${imgTask2.data.id}`)).data;
    if (detailCtx.project_name !== projNameNow) err(`图片任务缺项目名上下文: ${detailCtx.project_name}`);
    if (detailCtx.image_kind !== 'character') err(`图片任务缺 image_kind: ${detailCtx.image_kind}`);
    const listCtx = (await api('GET', '/api/tasks?limit=100')).data.items.find((x) => x.id === imgTask2.data.id);
    if (!listCtx?.project_name || listCtx.image_kind !== 'character') err('任务列表缺来源上下文字段');
    // 视频任务：先造一条挂项目镜头的任务再查（此时镜头已生成，见上方 17.5 分镜步骤）
    const pdForCtx = (await api('GET', `/api/projects/${pid}`)).data;
    const anyShot = (pdForCtx.shots || [])[0];
    if (anyShot) {
      const svCtx = await api('POST', `/api/projects/${pid}/shots/${anyShot.id}/videos`, {});
      if (svCtx.status === 201) {
        const svCtxRow = (await api('GET', `/api/tasks/${svCtx.data.id}`)).data;
        if (svCtxRow.project_name !== projNameNow) err(`视频任务缺项目名: ${svCtxRow.project_name}`);
        if (svCtxRow.shot_seq !== anyShot.seq) err(`视频任务缺镜头序号: ${svCtxRow.shot_seq}`);
        const svDoneCtx = await waitCompleted(svCtx.data.id, 40_000);
        if (svDoneCtx?.status !== 'completed') err(`上下文验证视频任务未完成: ${svDoneCtx?.status}`);
        ok(`任务来源上下文：视频任务带 项目名+镜头${svCtxRow.shot_seq}，图片任务带 项目名+角色图`);
      }
    }
  }

  // 17.17 v2.1：图片任务失败 → 重试为「原任务原地重新入队」（ID 不变 / retry_count 自增 / 重新流转）
  const imgFail = await api('POST', '/api/images/tasks', {
    prompt: 'FAIL_IMAGE 触发上游 400',
    size: '1K',
    ratio: '1:1',
  });
  if (imgFail.status !== 201) err(`失败图片任务创建失败: ${JSON.stringify(imgFail.data).slice(0, 200)}`);
  let imgFailed = null;
  const imgFl = Date.now() + 20_000;
  while (Date.now() < imgFl) {
    await sleep(500);
    imgFailed = (await api('GET', `/api/tasks/${imgFail.data.id}`)).data;
    if (imgFailed.status === 'failed') break;
  }
  if (imgFailed?.status !== 'failed') err(`图片任务应失败: ${imgFailed?.status}`);
  if (!imgFailed.error_message) err('失败图片任务缺少 error_message');
  const imgRetry = await api('POST', `/api/tasks/${imgFail.data.id}/retry`);
  if (imgRetry.status !== 200 || !imgRetry.data.reused) {
    err(`图片任务重试应原地复用: ${JSON.stringify(imgRetry.data).slice(0, 200)}`);
  }
  if (imgRetry.data.task.id !== imgFail.data.id) {
    err(`重试后任务 ID 变了: ${imgFail.data.id} → ${imgRetry.data.task.id}（应原地重置）`);
  }
  if (imgRetry.data.task.status !== 'queued' || imgRetry.data.task.retry_count !== 1) {
    err(`重试后状态/retry_count 异常: ${imgRetry.data.task.status} / ${imgRetry.data.task.retry_count}`);
  }
  if (imgRetry.data.task.error_message !== null || imgRetry.data.task.video_id !== null) {
    err('重试后未清空上次执行结果（error_message / video_id）');
  }
  ok(`图片任务失败 → 原地重试入队（任务 #${imgRetry.data.task.id} 不变 · retry_count=1 · 重新排队）`);
  // 清理：等待重试任务再度失败后删除（上游仍 400；避免干扰后续统计断言）
  {
    const dImgRetryFail = Date.now() + 20_000;
    while (Date.now() < dImgRetryFail) {
      await sleep(500);
      const r = (await api('GET', `/api/tasks/${imgFail.data.id}`)).data;
      if (r?.status === 'failed') break;
    }
    await api('DELETE', `/api/tasks/${imgFail.data.id}`);
  }

  // 18. 角色图生成（图片模型 → CDN URL + 本地备份）
  const img = await api('POST', '/api/images/generate', {
    prompt: '角色立绘：银发少年',
    size: '1K',
    ratio: '1:1',
    project_id: pid,
    kind: 'character',
  });
  if (img.status !== 200 || !img.data.remote_url) err(`角色图生成失败: ${JSON.stringify(img.data).slice(0, 300)}`);
  if (!img.data.image?.selected) err('角色图未自动定稿');
  ok(`角色图生成并定稿 #${img.data.image.id}（remote=${img.data.remote_url} local=${img.data.local_url || '无'}）`);

  // 18.1 图片选用 + 删除图片
  const selI = await api('POST', `/api/projects/${pid}/select-image`, { image_id: img.data.image.id });
  if (selI.status !== 200 || !selI.data.ok) err(`选用图片失败: ${JSON.stringify(selI.data)}`);
  const img2 = await api('POST', '/api/images/generate', {
    prompt: '场景概念图：黄昏麦田',
    size: '1K',
    ratio: '16:9',
    project_id: pid,
    kind: 'scene',
  });
  if (img2.status !== 200 || !img2.data.image?.id)
    err(`第二张图片生成失败: ${JSON.stringify(img2.data).slice(0, 200)}`);
  const delImg = await api('DELETE', `/api/images/${img2.data.image.id}`);
  if (delImg.status !== 200 || !delImg.data.ok) err(`删除图片失败: ${JSON.stringify(delImg.data)}`);
  const imgsAfter = (await api('GET', `/api/projects/${pid}`)).data.images;
  if (imgsAfter.some((x) => x.id === img2.data.image.id)) err('删除图片后仍存在于项目图片列表');
  const delImg404 = await api('DELETE', `/api/images/${img2.data.image.id}`);
  if (delImg404.status !== 404) err('重复删除图片未被 404 拒绝');
  ok(`图片选用/删除正常（定稿 #${img.data.image.id}，已删场景图 #${img2.data.image.id}）`);

  // 19. 从项目发起视频任务（2.5-flash reference 模式）
  const pv = await api('POST', `/api/projects/${pid}/videos`, { seconds: '8' });
  if (pv.status !== 201) err(`项目发视频失败: ${JSON.stringify(pv.data)}`);
  const rq = pv.data.request_json;
  if (rq.model !== 'agnes-video-2.5-flash') err(`视频模型错误: ${rq.model}`);
  if (rq.mode !== 'reference' || !Array.isArray(rq.images) || rq.images[0] !== img.data.remote_url) {
    err(`视频引用角色图错误: ${JSON.stringify(rq)}`);
  }
  if (!String(rq.prompt).includes('<Picture 1>')) err('视频提示词未自动注入 <Picture 1> 角色引用');
  if (pv.data.project_id !== pid) err('视频任务未关联项目');
  ok(`项目发起视频任务 #${pv.data.id}（reference + 角色图引用 + <Picture 1>）`);

  // 20. 项目视频任务轮询完成
  let pvFinal = null;
  const d3 = Date.now() + 20_000;
  while (Date.now() < d3) {
    await sleep(500);
    const r = await api('GET', `/api/tasks/${pv.data.id}`);
    pvFinal = r.data;
    if (pvFinal.status === 'completed' || pvFinal.status === 'failed') break;
  }
  if (!pvFinal || pvFinal.status !== 'completed') err(`项目视频任务未完成: ${JSON.stringify(pvFinal?.status)}`);
  if (!pvFinal.metadata_url) err('项目视频任务缺 metadata_url');
  ok(`项目视频任务轮询完成（视频: ${pvFinal.metadata_url}）`);
  const projDetail = await api('GET', `/api/projects/${pid}`);
  if (!projDetail.data.tasks.some((t) => t.id === pv.data.id)) err('项目详情未聚合视频任务');
  ok('项目详情聚合视频任务');

  // 20.1 单镜头提交视频任务（M2）：payload 用该镜头提示词 + shot_id/image_id 溯源
  const shot1 = projDetail.data.shots[0];
  const sv = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/videos`, {});
  if (sv.status !== 201) err(`单镜头提交失败: ${JSON.stringify(sv.data)}`);
  if (sv.data.shot_id !== shot1.id) err(`任务未关联镜头: ${sv.data.shot_id}`);
  if (!sv.data.image_id) err('任务未记录角色图溯源 image_id');
  if (sv.data.project_id !== pid) err('任务未关联项目');
  if (!sv.data.request_json.prompt.includes(shot1.video_prompt.slice(0, 30))) err('镜头提示词未用于任务 payload');
  if (!sv.data.request_json.prompt.includes('<Picture 1>')) err('单镜头任务提示词缺 <Picture 1>');
  if (sv.data.request_json.model !== 'agnes-video-2.5-flash' || sv.data.request_json.mode !== 'reference') {
    err(`单镜头任务模型/模式异常: ${JSON.stringify(sv.data.request_json)}`);
  }
  ok(`单镜头提交视频任务 #${sv.data.id}（shot_id=${sv.data.shot_id}，提示词与溯源正确）`);

  // 20.2 v1.3：镜头旁白/引用开关 —— 纯空镜走 text 模式，恢复后回到 reference
  const pn = await api('PATCH', `/api/projects/${pid}/shots/${shot1.id}`, {
    narration: '旁白测试句子',
    use_character_ref: false,
  });
  if (pn.status !== 200 || pn.data.narration !== '旁白测试句子' || pn.data.use_character_ref !== 0) {
    err(`镜头 narration/use_character_ref PATCH 未生效: ${JSON.stringify(pn.data)}`);
  }
  const svText = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/videos`, {});
  if (svText.status !== 201) err(`纯空镜镜头提交失败: ${JSON.stringify(svText.data)}`);
  const rqT = svText.data.request_json;
  if (rqT.mode !== 'text' || (rqT.images || []).length > 0 || svText.data.image_id) {
    err(`纯空镜镜头应走 text 模式且无参考图/图片溯源: ${JSON.stringify(rqT)}`);
  }
  await api('PATCH', `/api/projects/${pid}/shots/${shot1.id}`, { use_character_ref: true });
  const svRef = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/videos`, {});
  if (svRef.data.request_json.mode !== 'reference' || !(svRef.data.request_json.images || []).length) {
    err('恢复引用开关后应回到 reference 模式并带角色图');
  }
  await waitSubmitted(svText.data.id);
  await waitSubmitted(svRef.data.id);
  ok('镜头引用开关生效：纯空镜 text 模式（无参考图）↔ 恢复后 reference 模式');

  // 20.3 v1.3：superseded —— 同镜头旧失败记录在新任务成功后自动标记作废
  await mockRateLimit(99);
  const supFail = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/videos`, {});
  let supFailRow = null;
  {
    const d = Date.now() + 40_000;
    while (Date.now() < d) {
      supFailRow = (await api('GET', `/api/tasks/${supFail.data.id}`)).data;
      if (supFailRow.status === 'submit_error') break;
      await sleep(500);
    }
  }
  if (supFailRow?.status !== 'submit_error') err(`限流重试耗尽应落 submit_error，实际: ${supFailRow?.status}`);
  await mockRateLimit(0);
  const supOk = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/videos`, {});
  const supOkSub = await waitSubmitted(supOk.data.id, 40_000);
  if (!supOkSub?.video_id) err(`superseded 对照任务未提交成功: ${supOkSub?.status}`);
  const pdSup = await api('GET', `/api/projects/${pid}`);
  const failRow = pdSup.data.tasks.find((t) => t.id === supFail.data.id);
  if (!failRow?.superseded) err('同镜头存在更新成功任务后，旧 submit_error 未被标记 superseded');
  ok('superseded 标记：同镜头旧失败记录在新任务成功后自动作废');

  // 20.35 v1.4：BGM 音乐接口 —— 搜索代理 / 校验 / 选用并下载缓存
  const msr = await api('GET', `/api/music/search?keyword=${encodeURIComponent('夜曲')}&limit=3`);
  if (msr.status !== 200 || !Array.isArray(msr.data.items) || !msr.data.items.length) {
    err(`音乐搜索失败: ${JSON.stringify(msr.data).slice(0, 200)}`);
  }
  if (!msr.data.items[0].id || !msr.data.items[0].name) err('音乐搜索结果字段缺失（id/name）');
  ok(`BGM 音乐搜索代理正常（${msr.data.items.length} 条结果，字段规范化）`);
  const bgmEmptyKw = await api('GET', '/api/music/search?keyword=');
  if (bgmEmptyKw.status !== 400) err('空关键词搜索未被 400 拦截');
  const bgmSelBad = await api('POST', `/api/projects/${pid}/bgm`, { song_id: 'abc' });
  if (bgmSelBad.status !== 400) err('非数字 song_id 未被 400 拦截');
  const bgmSel = await api('POST', `/api/projects/${pid}/bgm`, {
    song_id: '12345',
    name: '测试曲',
    artist: '测试歌手',
    album: '测试专辑',
  });
  if (bgmSel.status !== 200 || !bgmSel.data.ok || !bgmSel.data.bgm?.local_url) {
    err(`BGM 选用失败: ${JSON.stringify(bgmSel.data).slice(0, 200)}`);
  }
  if (!fs.existsSync(bgmSel.data.bgm.local_path)) err('BGM 未下载到本地缓存');
  const pdBgm = await api('GET', `/api/projects/${pid}`);
  if (pdBgm.data.project?.bgm?.song_id !== '12345') err('项目 bgm 选择未落库');
  ok(`BGM 选用并缓存：${path.basename(bgmSel.data.bgm.local_path)}`);

  // 20.38 v1.5：注入两条「已完成」的镜头旁白（直接写测试库，模拟 Fish 合成产物），让渲染走完整声音链
  {
    const { DatabaseSync } = require('node:sqlite');
    const tdb = new DatabaseSync(TEST_DB);
    tdb.exec('PRAGMA busy_timeout = 5000');
    const now = Date.now();
    const ins =
      tdb.prepare(`INSERT INTO project_tts (project_id, kind, shot_id, text, model, voice_title, format, local_path, duration, size, selected, created_at)
      VALUES (?, 'shot', ?, ?, 's2.1-pro-free', '测试音色', 'mp3', ?, 6, 100000, 1, ?)`);
    const audioPath =
      bgmFixture && fs.existsSync(bgmFixture) ? bgmFixture : path.join(DATA_DIR_ROOT, 'e2e-bgm-fake.mp3');
    if (!fs.existsSync(audioPath)) fs.writeFileSync(audioPath, Buffer.alloc(4096, 3));
    ins.run(pid, shot1.id, '镜头一旁白测试', audioPath, now);
    ins.run(pid, projDetail.data.shots[1].id, '镜头二旁白测试', audioPath, now + 1);
    tdb.close();
  }
  ok('镜头旁白已注入（模拟 TTS 产物：高通+压缩+增益+闪避全链即将生效）');

  // 20.4 v1.3：一键成片渲染（真实 ffmpeg 端到端；无 ffmpeg 环境自动降级为校验断言）
  const shot2 = projDetail.data.shots[1];
  const sv2 = await api('POST', `/api/projects/${pid}/shots/${shot2.id}/videos`, {});
  if (sv2.status !== 201) err(`第二镜头提交失败: ${JSON.stringify(sv2.data)}`);
  const done1 = await waitCompleted(svRef.data.id);
  const done2 = await waitCompleted(sv2.data.id);
  if (done1?.status !== 'completed' || done2?.status !== 'completed') {
    err(`渲染素材未就绪: shot1=${done1?.status} shot2=${done2?.status}`);
  }
  const ren = await api('POST', `/api/projects/${pid}/render`, {
    transition_ms: 400,
    transition_type: 'slideup',
    title_card: true,
    end_card: true,
    aspect: '9:16',
    burn_subtitles: true,
    subtitle_fontsize: 42,
    subtitle_style: 'yellow-box',
    subtitle_position: 'bottom',
  });
  if (ren.status === 400 && String(ren.data.error).includes('ffmpeg')) {
    ok('成片渲染：本环境无 ffmpeg，跳过真实渲染（校验通过）');
  } else {
    if (ren.status !== 201) err(`渲染任务创建失败: ${JSON.stringify(ren.data)}`);
    if (ren.data.status !== 'queued') err('渲染任务应从 queued 开始');
    if (ren.data.params?.bgm_volume === undefined || ren.data.params?.bgm_duck === undefined)
      err('渲染参数缺少 BGM 字段');
    if (ren.data.params?.narration_volume === undefined) err('渲染参数缺少 narration_volume');
    if (ren.data.params?.burn_subtitles === undefined || ren.data.params?.subtitle_fontsize === undefined)
      err('渲染参数缺少字幕烧录字段');
    if (ren.data.params?.aspect !== '9:16') err(`竖屏 aspect 参数未生效: ${ren.data.params?.aspect}`);
    // v2.0：转场类型 / 字幕样式 / 位置 白名单参数透传
    if (ren.data.params?.transition_type !== 'slideup')
      err(`transition_type 未生效: ${ren.data.params?.transition_type}`);
    if (ren.data.params?.subtitle_style !== 'yellow-box')
      err(`subtitle_style 未生效: ${ren.data.params?.subtitle_style}`);
    if (ren.data.params?.subtitle_position !== 'bottom')
      err(`subtitle_position 未生效: ${ren.data.params?.subtitle_position}`);
    // v1.6：ASS 字幕生成纯函数（时间轴格式 / 文本转义保留 / 淡入淡出标记）
    {
      const { buildSubtitleAss } = require('../services/subtitles');
      const ass = buildSubtitleAss(
        [
          { start: 3.3, end: 7.05, text: '测试,字幕{文本}' },
          { start: 8, end: 7, text: '无效区间应被剔除' },
        ],
        { fontsize: 42 },
      );
      if (!ass.includes('Dialogue: 0,0:00:03.30,0:00:07.05,Narr'))
        err(`ASS 时间轴格式错误: ${ass.split('\n').find((l) => l.startsWith('Dialogue')) || ''}`);
      if (!ass.includes('测试,字幕文本')) err('ASS 文本丢失或转义错误（花括号应被剔除、逗号应保留）');
      if (!ass.includes('\\fad(150,150)')) err('ASS 缺少淡入淡出标记');
      if (ass.includes('无效区间')) err('end<=start 的无效字幕行未剔除');
      if (!ass.includes('PlayResX: 1280')) err('ASS 缺少 PlayRes');
    }
    let renJob = null;
    const dRen = Date.now() + 180_000;
    while (Date.now() < dRen) {
      renJob = (await api('GET', `/api/render/jobs/${ren.data.id}`)).data;
      if (['completed', 'failed'].includes(renJob.status)) break;
      await sleep(1000);
    }
    if (renJob?.status !== 'completed') {
      err(`渲染未完成: ${renJob?.status} / ${renJob?.error_message}`);
    }
    if (!renJob.output_url || !fs.existsSync(renJob.output_path)) err('渲染产物缺失');
    // v1.8：竖屏尺寸 + 封面候选
    const { spawnSync: ss } = require('node:child_process');
    const fp = ss(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        renJob.output_path,
      ],
      { encoding: 'utf8' },
    );
    let dur = NaN,
      vw = 0,
      vh = 0;
    try {
      const meta = JSON.parse(fp.stdout || '{}');
      dur = Number(meta.format?.duration);
      const v = (meta.streams || []).find((s) => s.width);
      vw = v?.width;
      vh = v?.height;
    } catch {
      /* ignore */
    }
    if (Number.isFinite(dur) && (dur < 6 || dur > 20)) err(`成片时长异常: ${dur}s`);
    if (vw !== 720 || vh !== 1280) err(`竖屏尺寸异常: ${vw}x${vh}（应为 720x1280）`);
    if (!Array.isArray(renJob.covers) || !renJob.covers.length || !fs.existsSync(renJob.covers[0].path))
      err('封面候选未生成');
    ok(
      `一键成片渲染完成：${path.basename(renJob.output_path)}（${Number.isFinite(dur) ? dur.toFixed(1) + 's' : '?'} · 竖屏 ${vw}x${vh} · 封面 ${renJob.covers.length} 张 · 含片头/片尾卡与叠化）`,
    );

    // v2.2 作品归档：data/works/《项目名》-id/ 含 成片/字幕/台词（同步归档），海报异步轮询
    if (!renJob.work_dir) err('渲染完成未携带 work_dir 作品目录');
    else {
      const wkName = path.basename(renJob.work_dir);
      if (!wkName.includes(`-${pid}`) || !wkName.startsWith('《'))
        err(`作品目录名异常: ${wkName}（应为《项目名》-id）`);
      const fmp4 = path.join(renJob.work_dir, `成片-${renJob.id}.mp4`);
      const fsrt = path.join(renJob.work_dir, `字幕-${renJob.id}.srt`);
      const ftxt = path.join(renJob.work_dir, '旁白台词.txt');
      if (!fs.existsSync(fmp4)) err(`作品目录缺成片: ${fmp4}`);
      if (!fs.existsSync(fsrt)) err(`作品目录缺字幕: ${fsrt}`);
      if (!fs.existsSync(ftxt)) err(`作品目录缺旁白台词: ${ftxt}`);
      const srtContent = fs.readFileSync(fsrt, 'utf8');
      if (!srtContent.includes('-->') || !srtContent.includes('旁白测试')) err('SRT 内容异常（无时间轴或无台词）');
      if (!fs.readFileSync(ftxt, 'utf8').includes('旁白台词')) err('台词文件标题缺失');
      // 海报（LLM→文生图→叠标题，异步）：轮询至多 60s（mock 链路完整应秒级）
      let posterOk = false;
      const dPoster = Date.now() + 60_000;
      while (Date.now() < dPoster) {
        if (fs.existsSync(path.join(renJob.work_dir, '海报.png'))) {
          posterOk = true;
          break;
        }
        await sleep(1500);
      }
      ok(`作品归档：${wkName}（成片/字幕/台词 ✓${posterOk ? ' · 海报 ✓' : ' · 海报未就绪（best-effort 不阻塞）'}）`);
      // v2.2 作品库接口：/api/works 汇总全部作品（含刚归档的这部）
      const wkLib = (await api('GET', '/api/works')).data;
      const wkItem = (wkLib.items || []).find((x) => x.project_id === pid);
      if (!wkItem) err(`作品库 /api/works 未包含刚归档的作品（pid=${pid}, total=${wkLib.total}）`);
      else {
        if (!wkItem.films?.length || !wkItem.films[0].url?.startsWith('/works/'))
          err(`作品库成片 URL 异常: ${JSON.stringify(wkItem.films?.[0])}`);
        if (wkItem.quality?.duration_s !== renJob.quality?.duration_s) err('作品库质检报告与渲染任务不一致');
        if (wkItem.poster?.url && !wkItem.poster.url.startsWith('/works/')) err('作品库海报 URL 异常');
      }
      ok(`作品库：${wkLib.total} 部作品，最新《${wkItem?.name}》成片/海报/质检 ✓`);
    }
    const delJob = await api('DELETE', `/api/render/jobs/${ren.data.id}`);
    if (delJob.status !== 200 || fs.existsSync(renJob.output_path)) err('渲染任务删除应连带清理产物文件');
    ok('渲染任务删除并清理产物文件');

    // v1.9.2 渲染自愈：崩溃遗留的 rendering 任务启动时复位回 queued 重新渲染（闭环验证）
    {
      const stuckJob = (await api('POST', `/api/projects/${pid}/render`, {})).data;
      // 直接把任务置成 rendering（模拟进程崩溃瞬间的库内状态），renderer.start() 应复位回 queued
      const { DatabaseSync } = require('node:sqlite');
      const dbx = new DatabaseSync(process.env.DB_PATH);
      dbx.prepare("UPDATE render_jobs SET status = 'rendering', progress = 42 WHERE id = ?").run(stuckJob.id);
      dbx.close();
      const renderer = require('../workers/render');
      renderer.start(); // 内部先复位孤儿 rendering 任务（新定时器 1.5s 后才首次 tick）
      await sleep(200);
      const after = (await api('GET', `/api/render/jobs/${stuckJob.id}`)).data;
      if (after.status !== 'queued') {
        err(`渲染自愈未生效：崩溃遗留任务应复位回 queued，实际: ${after.status}`);
      }
      // 等复位后的重新渲染走完闭环（复用渲染超时上限）
      let healed = after;
      const dHeal = Date.now() + 180_000;
      while (Date.now() < dHeal && !['completed', 'failed'].includes(healed.status)) {
        healed = (await api('GET', `/api/render/jobs/${stuckJob.id}`)).data;
        await sleep(1000);
      }
      if (healed.status !== 'completed') err(`自愈重渲染未完成: ${healed.status} / ${healed.error_message}`);
      else ok(`渲染自愈闭环：rendering 孤儿复位 → 重新渲染完成（${path.basename(healed.output_path || '?')}）`);
      await api('DELETE', `/api/render/jobs/${stuckJob.id}`);
    }
  }

  // 20.44 P3：L1 分镜 AI 审查（手动触发）+ 全自动成片端到端闭环
  {
    // L1：审查现有分镜（mock 返回 2 条建议：low=旁白修订 / high=提示词硬伤留人工）
    const rv = await api('POST', `/api/projects/${pid}/storyboard/review`);
    if (rv.status !== 200 || !rv.data.parsed) err(`分镜审查失败: ${JSON.stringify(rv.data).slice(0, 200)}`);
    if (rv.data.issues?.length !== 2) err(`审查应返回 2 条建议: ${rv.data.issues?.length}`);
    if (!rv.data.issues[0].revised) err('审查建议缺少 revised 修订文本');
    ok(`L1 分镜审查：返回 ${rv.data.issues.length} 条建议（高/低严重度分级 + 可采纳修订）`);

    // 全自动成片：新项目从创意到成片全自动推进（TTS 未配置 Fish Key 自动跳过）
    const autoProj = await api('POST', '/api/projects', {
      name: '全自动成片测试',
      idea: '黄昏麦田，穿黄胶鞋的少年沿土路走向远方，暖金色逆光',
      style: '电影写实',
      seconds: '5',
    });
    const apid = autoProj.data.id;
    const autoStart = await api('POST', `/api/projects/${apid}/auto`);
    if (autoStart.status !== 202 || !autoStart.data.auto_state?.running)
      err(`全自动启动失败: ${JSON.stringify(autoStart.data).slice(0, 200)}`);
    const autoDup = await api('POST', `/api/projects/${apid}/auto`);
    if (autoDup.status !== 400) err('重复启动全自动未被 400 拦截');
    ok(`全自动成片已启动（项目 #${apid}；重复启动 400 拦截）`);

    let autoSt = null;
    const dAuto = Date.now() + 120_000;
    while (Date.now() < dAuto) {
      await sleep(1500);
      autoSt = (await api('GET', `/api/projects/${apid}/auto`)).data.auto_state;
      if (autoSt && !autoSt.running) break;
    }
    if (!autoSt || autoSt.stage !== 'done') {
      err(
        `全自动成片未完成: stage=${autoSt?.stage} err=${autoSt?.error} hist=${JSON.stringify((autoSt?.history || []).map((h) => h.stage + ':' + h.status))}`,
      );
    }
    const stagesDone = (autoSt.history || []).filter((h) => h.status === 'ok').map((h) => h.stage);
    for (const s of [
      'storyboard',
      'review',
      'character',
      'videos',
      'wait_videos',
      'tts',
      'bgm',
      'render',
      'wait_render',
      'done',
    ]) {
      if (!stagesDone.includes(s)) err(`全自动历史缺少阶段 ${s}: ${JSON.stringify(stagesDone)}`);
    }
    // L1 自动修订：low 严重度的旁白修订应已写入镜头 1（medium/low 自动采纳，high 留人工）
    const autoDetail = (await api('GET', `/api/projects/${apid}`)).data;
    // v2.1 bgm 阶段：音乐接口已配置（指向 mock），全自动应自动选中 BGM
    if (!autoDetail.project?.bgm?.song_id) err('全自动 bgm 阶段未自动选中 BGM');
    if (autoDetail.project?.bgm?.name !== '测试曲') err(`自动选曲名称异常: ${autoDetail.project?.bgm?.name}`);
    // 选曲结果记录在「进入 render」的历史条目里（doBgm advance 到 render 时携带选曲说明）
    const renderEntry = (autoSt.history || []).find((h) => h.stage === 'render' && h.status === 'ok');
    if (!renderEntry || !String(renderEntry.detail || '').includes('配乐已选')) {
      err(`bgm 阶段选曲说明缺失: ${JSON.stringify(renderEntry)}`);
    }
    if (!autoDetail.shots.some((s) => s.narration === '暮色拉长了土路，夏天走成了脚印。'))
      err('L1 自审的 low 严重度修订未自动应用到镜头旁白');
    if (autoDetail.tasks.some((t) => t.status !== 'completed')) err('全自动后存在未完成的视频任务');
    const autoJobs = (await api('GET', `/api/projects/${apid}/render/jobs`)).data.items;
    const autoJob = autoJobs.find((j) => j.status === 'completed');
    if (!autoJob || !autoJob.output_url) err('全自动渲染产物缺失');
    if (!autoJob.quality || !autoJob.quality.duration_s || autoJob.quality.shots !== 2)
      err(`质检报告缺失或异常: ${JSON.stringify(autoJob.quality)}`);
    ok(
      `全自动成片闭环完成 🎉（${autoDetail.shots.length} 镜 · 成片 ${autoJob.quality.duration_s}s · 响度 ${autoJob.quality.loudness_lufs ?? '?'} LUFS · L1 修订已应用 · TTS 未配置自动跳过 · BGM 自动选《${autoDetail.project?.bgm?.name}》）`,
    );
  }

  // 20.45 v1.4：清除 BGM 选择
  const bgmDel = await api('DELETE', `/api/projects/${pid}/bgm`);
  if (bgmDel.status !== 200 || !bgmDel.data.ok) err('清除 BGM 失败');
  const pdBgm2 = await api('GET', `/api/projects/${pid}`);
  if (pdBgm2.data.project?.bgm) err('清除 BGM 后项目仍保留选择');
  ok('BGM 清除正常（本地缓存文件保留）');

  // 20.5 v1.3：TTS 镜头绑定校验（仅校验层，不触发真实 Fish 合成）
  const ttsBad1 = await api('POST', '/api/tts/generate', { text: '旁白', shot_id: shot1.id });
  if (!(ttsBad1.status === 400 && String(ttsBad1.data.error).includes('project_id'))) {
    err(`tts shot_id 缺 project_id 未按预期拦截: ${JSON.stringify(ttsBad1.data)}`);
  }
  const ttsBad2 = await api('POST', '/api/tts/generate', { text: '旁白', project_id: pid, shot_id: 999999 });
  if (!(ttsBad2.status === 404 && String(ttsBad2.data.error).includes('镜头不存在'))) {
    err(`tts 跨项目 shot_id 未被 404 拦截: ${JSON.stringify(ttsBad2.data)}`);
  }
  ok('TTS 镜头绑定：shot_id 需与 project_id 同提供、跨项目镜头 404');

  // 20.6 v1.5：旁白绑定/解绑（含同镜头互斥让位）
  {
    const { DatabaseSync } = require('node:sqlite');
    const tdb = new DatabaseSync(TEST_DB);
    tdb.exec('PRAGMA busy_timeout = 5000');
    const now = Date.now();
    const r = tdb
      .prepare(
        `INSERT INTO project_tts (project_id, kind, text, model, voice_title, format, local_path, duration, size, selected, created_at)
      VALUES (?, 'narration', '整片旁白测试', 's2.1-pro-free', '测试音色', 'mp3', ?, 6, 100000, 0, ?)`,
      )
      .run(
        pid,
        bgmFixture && fs.existsSync(bgmFixture) ? bgmFixture : path.join(DATA_DIR_ROOT, 'e2e-bgm-fake.mp3'),
        now,
      );
    tdb.close();
    const ttsId = Number(r.lastInsertRowid);
    const b1 = await api('POST', `/api/tts/${ttsId}/bind`, { project_id: pid, shot_id: shot1.id });
    if (b1.status !== 200 || b1.data.tts?.kind !== 'shot' || b1.data.tts?.shot_id !== shot1.id) {
      err(`旁白绑定镜头失败: ${JSON.stringify(b1.data).slice(0, 200)}`);
    }
    const pdBind = await api('GET', `/api/projects/${pid}`);
    const shot1Bound = pdBind.data.tts.filter((t) => t.kind === 'shot' && t.shot_id === shot1.id);
    if (shot1Bound.length !== 1 || shot1Bound[0].id !== ttsId) err('同镜头互斥失败：旧绑定未自动让位');
    const b2 = await api('POST', `/api/tts/${ttsId}/bind`, { project_id: pid, shot_id: null });
    if (b2.status !== 200 || b2.data.tts?.kind !== 'narration' || b2.data.tts?.shot_id !== null)
      err(`解绑失败: ${JSON.stringify(b2.data)}`);
    const b3 = await api('POST', `/api/tts/${ttsId}/bind`, { project_id: 999999, shot_id: 1 });
    if (b3.status !== 404) err('跨项目绑定未被 404 拦截');
    ok('旁白绑定：绑定 / 同镜头互斥让位 / 解绑 / 跨项目 404 全部正常');

    // 20.7 v1.7：多镜头重拍 —— 重拍候选 / 定稿选定 / 渲染优先用定稿 / 删除回退自动
    {
      const rt = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/retakes`, { count: 1 });
      if (rt.status !== 201 || !rt.data.retakes?.length) err(`重拍提交失败: ${JSON.stringify(rt.data).slice(0, 200)}`);
      const rtTask = rt.data.retakes[0];
      const rtDone = await waitCompleted(rtTask.id, 30_000);
      if (rtDone?.status !== 'completed') err(`重拍任务未完成: ${rtDone?.status}`);
      // 选一条「较旧」的完成条为定稿（若渲染仍取最新即可判定未生效）
      const oldTake = (await api('GET', `/api/projects/${pid}`)).data.tasks
        .filter((t) => t.shot_id === shot1.id && t.status === 'completed' && t.id !== rtTask.id)
        .sort((a, b) => b.id - a.id)[0];
      const pick = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/select-take`, { task_id: oldTake.id });
      if (pick.status !== 200 || pick.data.shot?.take_task_id !== oldTake.id)
        err(`选定 take 失败: ${JSON.stringify(pick.data).slice(0, 200)}`);
      // collectSegments 应优先取定稿条
      const { collectSegments } = require('../workers/render');
      const seg1 = collectSegments(pid).segments.find((s) => s.shot.id === shot1.id);
      if (!seg1 || seg1.src !== oldTake.video_local_path) err('渲染素材未优先使用选定定稿 take');
      // 校验：非本镜头任务不可选
      const badSel = await api('POST', `/api/projects/${pid}/shots/${shot1.id}/select-take`, { task_id: 999999 });
      if (badSel.status !== 404) err('跨镜头任务选定未被 404 拦截');
      // 删除定稿任务 → 清引用回退自动模式
      const delPicked = await api('DELETE', `/api/tasks/${oldTake.id}`);
      if (delPicked.status !== 200) err('删除定稿任务失败');
      const afterDel = (await api('GET', `/api/projects/${pid}`)).data.shots.find((s) => s.id === shot1.id);
      if (afterDel.take_task_id !== null) err('删除定稿任务后未回退自动模式');
      ok('多镜头重拍：候选提交 / 定稿选定 / 渲染优先定稿 / 删除回退自动 全部正常');
    }
  }

  // 21. 删除项目（级联清理 + 任务解绑）
  const delR = await api('DELETE', `/api/projects/${pid}`);
  if (delR.status !== 200 || !delR.data.ok) err(`删除项目失败: ${JSON.stringify(delR.data)}`);
  const delAgain = await api('DELETE', `/api/projects/${pid}`);
  if (delAgain.status !== 404) err('重复删除项目未被 404 拒绝');
  const afterDel = await api('GET', `/api/projects/${pid}`);
  if (afterDel.status !== 404) err('删除后项目详情仍可访问');
  const pvAfterDel = await api('GET', `/api/tasks/${pv.data.id}`);
  if (pvAfterDel.status !== 200 || pvAfterDel.data.project_id !== null) {
    err(
      `删除项目后视频任务应保留且解除关联: ${JSON.stringify({ status: pvAfterDel.status, project_id: pvAfterDel.data?.project_id })}`,
    );
  }
  ok('删除项目：级联清理文案/角色图，视频任务保留并解绑（project_id=null）');

  // 21.1 清理干扰项目
  await api('DELETE', `/api/projects/${proj2.data.id}`);

  // 9. 统计
  const stats = await api('GET', '/api/stats');
  if (!stats.data?.byStatus?.completed) err('统计异常');
  ok(`统计：完成 ${stats.data.byStatus.completed} 条`);

  // 10.1 日志接口
  const logs = await api('GET', '/api/logs');
  if (logs.status !== 200 || !Array.isArray(logs.data.items) || !logs.data.items.length) err('日志接口异常');
  if (!logs.data.items.every((l) => typeof l.msg === 'string' && 'level' in l)) err('日志条目结构异常');
  if (JSON.stringify(logs.data.items).includes('sk-test-key-1234')) err('日志中泄露 API Key');
  ok(`日志接口正常（items=${logs.data.items.length}，无密钥泄露）`);

  // 10.2 重试端点：404 / 仅失败态可重试 / 视频任务原地重试闭环（ID 不变 → 重新排队 → 完成）
  const retry404 = await api('POST', '/api/tasks/999999/retry', {});
  if (retry404.status !== 404) err('重试不存在的任务未被 404 拒绝');
  const retryBad = await api('POST', `/api/tasks/${taskId}/retry`, {});
  if (retryBad.status !== 400 || !String(retryBad.data.error).includes('仅 failed')) {
    err(`completed 任务重试未被 400 拦截: ${JSON.stringify(retryBad.data)}`);
  }
  ok('校验：重试 404 / completed 任务不可重试');
  {
    // v2.1 视频任务原地重试闭环：429 重试耗尽会落 submit_error → retry → 原任务重新流转直至完成
    await mockRateLimit(6); // MAX_ATTEMPTS=5，6 次退避后必然 submit_error
    const vr = await api('POST', '/api/tasks', {
      model: 'agnes-video-2.5-flash',
      prompt: '原地重试闭环测试：雪夜路灯下的邮筒',
      mode: 'text',
      seconds: '5',
    });
    if (vr.status !== 201) err(`原地重试任务创建失败: ${JSON.stringify(vr.data).slice(0, 150)}`);
    const vrId = vr.data.id;
    let vrRow = null;
    const vrDl = Date.now() + 90_000; // 6 次退避（基数 500ms 起）+ 重试后提交
    while (Date.now() < vrDl) {
      await sleep(600);
      vrRow = (await api('GET', `/api/tasks/${vrId}`)).data;
      if (vrRow.status === 'submit_error' || vrRow.status === 'failed') break;
    }
    if (!['submit_error', 'failed'].includes(vrRow?.status)) {
      err(`原地重试前置失败：任务应先失败（实际 ${vrRow?.status}，限流计数可能未生效）`);
    }
    await mockRateLimit(0); // 解除限流
    const vrRetry = await api('POST', `/api/tasks/${vrId}/retry`);
    if (vrRetry.status !== 200 || vrRetry.data.task.id !== vrId || vrRetry.data.task.status !== 'queued') {
      err(`视频任务原地重试异常: ${JSON.stringify(vrRetry.data).slice(0, 200)}`);
    }
    if (vrRetry.data.task.retry_count !== 1) err(`retry_count 应为 1: ${vrRetry.data.task.retry_count}`);
    const vrDone = await waitCompleted(vrId, 40_000);
    if (vrDone?.status !== 'completed') err(`原地重试后未完成: ${vrDone?.status} / ${vrDone?.error_message}`);
    if (!vrDone.video_id) err('原地重试完成后缺少 video_id');
    const vrCtx = (await api('GET', `/api/tasks/${vrId}`)).data;
    if (vrCtx.project_name !== null) err(`独立任务 project_name 应为 null: ${vrCtx.project_name}`);
    ok(`视频任务原地重试闭环：#${vrId} submit_error → 重试（ID 不变·retry_count=1）→ completed`);
  }

  // 10.3 立即查询端点：404 / 已完成任务查询返回当前状态
  const poll404 = await api('POST', '/api/tasks/999999/poll', {});
  if (poll404.status !== 404) err('查询不存在的任务未被 404 拒绝');
  const pollDone = await api('POST', `/api/tasks/${taskId}/poll`, {});
  if (pollDone.status !== 200 || pollDone.data.ok !== true || pollDone.data.status !== 'completed') {
    err(`已完成任务手动查询异常: ${JSON.stringify(pollDone.data)}`);
  }
  ok('手动查询：404 拦截 + 已完成任务返回 completed');

  // 10.4 删除任务：删除后 GET 404
  const delTask = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash',
    prompt: '待删除任务',
    mode: 'text',
    seconds: '5',
    size: '720P',
    aspect_ratio: '16:9',
  });
  if (delTask.status !== 201) err(`创建待删除任务失败: ${JSON.stringify(delTask.data)}`);
  const delT = await api('DELETE', `/api/tasks/${delTask.data.id}`);
  if (delT.status !== 200 || !delT.data.ok) err(`删除任务失败: ${JSON.stringify(delT.data)}`);
  const delTGet = await api('GET', `/api/tasks/${delTask.data.id}`);
  if (delTGet.status !== 404) err('删除后任务仍可访问');
  const delT404 = await api('DELETE', `/api/tasks/${delTask.data.id}`);
  if (delT404.status !== 404) err('重复删除任务未被 404 拒绝');
  ok(`删除任务正常（#${delTask.data.id} 已删并 404）`);

  // 10.5 批量清空：先清失败（可能 0 条），再清已完成（应 ≥3 条）
  const bulkF = await api('POST', '/api/tasks/bulk/clear-failed', {});
  if (bulkF.status !== 200 || typeof bulkF.data.removed !== 'number')
    err(`清空失败任务异常: ${JSON.stringify(bulkF.data)}`);
  const bulkC = await api('POST', '/api/tasks/bulk/clear-completed', {});
  if (bulkC.status !== 200 || bulkC.data.removed < 3) err(`清空已完成任务异常: ${JSON.stringify(bulkC.data)}`);
  const statsAfter = await api('GET', '/api/stats');
  if ((statsAfter.data.byStatus.completed || 0) !== 0) err('清空已完成任务后仍有 completed 残留');
  ok(`批量清空正常（失败 ${bulkF.data.removed} 条 / 已完成 ${bulkC.data.removed} 条）`);

  // 10. 静态首页
  const home = await fetch(APP_BASE + '/');
  const html = await home.text();
  if (!html.includes('Agnes Video 任务控制台')) err('首页未正常渲染');
  ok('静态首页可访问');

  console.log('\n== 全部通过 ✔ ==');
  mockServer.close();
  // 清理测试产物（测试库与测试专用 artifacts 目录），生产 data/agnes-console.db 与 data/artifacts 不受影响
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
  try {
    fs.rmSync(TEST_ARTIFACTS, { recursive: true, force: true });
  } catch {}
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试崩溃:', e);
  process.exit(1);
});
