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
const TEST_DB = path.join(__dirname, '..', 'data', 'e2e-test.db');

/* ---------------- 模拟 Agnes API ---------------- */
const mockJobs = new Map(); // video_id -> job
let seq = 0;

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
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'POST' && u.pathname === '/v1/videos') {
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

  send(404, { detail: 'not found' });
});

/* ---------------- 工具 ---------------- */
const err = (msg) => { console.error('\n✗ FAIL: ' + msg); process.exit(1); };
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

/* ---------------- 主流程 ---------------- */
(async () => {
  console.log('== Agnes Video 任务控制台 端到端冒烟测试 ==');
  try { fs.rmSync(TEST_DB, { force: true }); fs.rmSync(TEST_DB + '-wal', { force: true }); fs.rmSync(TEST_DB + '-shm', { force: true }); } catch {}

  // 启动 Mock Agnes API
  await new Promise((r) => mockServer.listen(MOCK_PORT, r));
  console.log(`[mock] Agnes API 模拟服务器已启动于 :${MOCK_PORT}`);

  // 配置并启动控制台（独立端口 + 独立数据库）
  process.env.PORT = String(APP_PORT);
  process.env.DB_PATH = TEST_DB;
  process.env.DATA_DIR = path.join(__dirname, '..', 'data');
  require('../server');
  await sleep(600);
  console.log(`[app] 控制台已启动于 :${APP_PORT}`);

  // 1. 健康检查
  const health = await api('GET', '/api/health');
  if (!health.data?.ok) err('健康检查失败');
  ok('健康检查 /api/health');

  // 2. 设置（指向 mock + 假 key）
  const set = await api('PUT', '/api/settings', {
    api_key: 'sk-test-key-1234',
    base_url: `http://127.0.0.1:${MOCK_PORT}`,
    poll_interval_ms: 500,
    max_active_minutes: 1,
  });
  if (set.status !== 200) err('保存设置失败');
  ok('保存设置（base_url→mock）');

  // 3. 掩码校验：key 不出现在设置响应中
  const st = await api('GET', '/api/settings');
  if (st.data.api_key_masked !== 'sk-t****1234') err(`API Key 掩码异常: ${JSON.stringify(st.data.api_key_masked)}`);
  if (JSON.stringify(st.data).includes('sk-test-key-1234')) err('API Key 泄露到设置响应');
  ok('API Key 仅以掩码返回，未泄露');

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
  if (!created.data.video_id) err('创建任务未返回 video_id');
  ok(`已创建任务 #${taskId}，video_id=${created.data.video_id}`);

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
  ok(`轮询闭环完成：${final.status} @ ${final.progress}%，轮询 ${final.poll_count} 次（含 pending 状态兜底），视频: ${final.metadata_url}`);

  // 6. 校验规则：text 模式带媒体 → 400
  const bad1 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'text',
    images: ['https://example.com/a.png'],
  });
  if (bad1.status !== 400) err('text 模式携带图片未被拦截');
  ok('校验：text 模式携带媒体被 400 拒绝');

  // 7. 校验规则：flash + 视频参考 → 400
  const bad2 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'reference',
    videos: ['https://example.com/a.mp4'],
  });
  if (bad2.status !== 400) err('flash 视频参考未被拦截');
  ok('校验：Flash 模型 videos 被 400 拒绝');

  // 8. 校验规则：reference 无素材 → 400
  const bad3 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'reference',
  });
  if (bad3.status !== 400) err('reference 无素材未被拦截');
  ok('校验：reference 模式无素材被 400 拒绝');

  // 9. V2.0：文生视频
  const v2a = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0', prompt: 'cat walking on the beach at sunset',
    mode: 'text', num_frames: 121, frame_rate: 24, width: 1280, height: 720,
  });
  if (v2a.status !== 201) err(`V2.0 文生创建失败: ${JSON.stringify(v2a.data)}`);
  const rqa = v2a.data.request_json;
  if (rqa.num_frames !== 121 || rqa.frame_rate !== 24 || rqa.image || rqa.extra_body) {
    err(`V2.0 文生 payload 异常: ${JSON.stringify(rqa)}`);
  }
  if (v2a.data.size !== '1280x720' || v2a.data.aspect_ratio !== '16:9') {
    err(`V2.0 尺寸/画幅计算异常: ${v2a.data.size}/${v2a.data.aspect_ratio}`);
  }
  ok(`V2.0 文生创建成功 #${v2a.data.id}（size=${v2a.data.size}，aspect=${v2a.data.aspect_ratio}，seconds=${v2a.data.seconds}）`);

  // 10. V2.0：图生视频
  const v2b = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0', prompt: 'animate the character with subtle breathing',
    mode: 'image', num_frames: 81, frame_rate: 24, width: 720, height: 720,
    image: 'https://example.com/char.png',
  });
  if (v2b.status !== 201) err(`V2.0 图生创建失败: ${JSON.stringify(v2b.data)}`);
  if (v2b.data.request_json.image !== 'https://example.com/char.png') err('V2.0 图生 payload 缺 image');
  ok(`V2.0 图生创建成功 #${v2b.data.id}（含 image URL）`);

  // 11. V2.0：关键帧动画（extra_body）
  const v2c = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0', prompt: 'smooth transition between keyframes',
    mode: 'keyframes', num_frames: 121, frame_rate: 24,
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
    model: 'agnes-video-v2.0', prompt: 'x', mode: 'text', num_frames: 100,
  });
  if (badV2.status !== 400) err('num_frames=100 未被拦截');
  ok('校验：V2.0 num_frames 不满足 8n+1 被 400 拒绝');

  // 13. V2.0 校验：关键帧少于 2 张 → 400
  const badV2b = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0', prompt: 'x', mode: 'keyframes', num_frames: 121,
    images: ['https://example.com/kf1.png'],
  });
  if (badV2b.status !== 400) err('关键帧 1 张未被拦截');
  ok('校验：V2.0 关键帧少于 2 张被 400 拒绝');

  // 14. V2.0 校验：图生缺 image → 400
  const badV2c = await api('POST', '/api/tasks', {
    model: 'agnes-video-v2.0', prompt: 'x', mode: 'image', num_frames: 121,
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

  // 9. 统计
  const stats = await api('GET', '/api/stats');
  if (!stats.data?.byStatus?.completed) err('统计异常');
  ok(`统计：完成 ${stats.data.byStatus.completed} 条`);

  // 10. 静态首页
  const home = await fetch(APP_BASE + '/');
  const html = await home.text();
  if (!html.includes('Agnes Video 任务控制台')) err('首页未正常渲染');
  ok('静态首页可访问');

  console.log('\n== 全部通过 ✔ ==');
  mockServer.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试崩溃:', e);
  process.exit(1);
});