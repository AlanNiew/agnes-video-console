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

  // 模拟文本模型 /v1/chat/completions
  // 分派依据结构化契约而非具体措辞：文案生成的 system 必须要求「JSON 对象」输出（这是
  // 控制台解析逻辑的依赖契约），提示词优化则以「优化」关键词识别，其余走通用回复
  if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const sys = (body.messages || []).find((m) => m.role === 'system')?.content || '';
    let content;
    if (sys.includes('JSON 对象')) {
      content = JSON.stringify({
        script: '测试梗概：夏日黄昏，穿黄胶鞋的少年沿着麦田土路走向远方，镜头跟随他的背影，暖金色逆光，宁静而怀念。',
        video_prompt: '以 <Picture 1> 中的角色为参考，保持其外观一致。少年沿麦田土路走向远方，麦浪随风起伏，暖金色逆光，镜头缓慢横摇，电影写实风格，自然环境声',
        character_desc: '十五岁少年，黑色短发，穿旧蓝白校服与黄色胶鞋，清瘦，腼腆，电影写实',
        scene_desc: '黄昏麦田土路，麦浪起伏，暖金色逆光，天边晚霞',
      });
    } else if (sys.includes('优化')) {
      content = '雨后的未来城市街道，霓虹灯倒映在湿漉漉的地面，一辆银色跑车缓缓驶过，镜头缓慢横摇跟随，电影级写实风格，自然环境声，高细节';
    } else {
      content = '（mock）通用文本回复';
    }
    return send(200, { choices: [{ message: { role: 'assistant', content } }], model: body.model || 'agnes-2.5-flash' });
  }

  // 模拟图片模型 /v1/images/generations（返回 CDN URL）
  if (req.method === 'POST' && u.pathname === '/v1/images/generations') {
    seq += 1;
    const url = `http://127.0.0.1:${MOCK_PORT}/out/img-mock-${seq}.png`;
    return send(200, { created: Date.now(), data: [{ url, b64_json: null, revised_prompt: null }] });
  }

  // 模拟生成结果图片（供本地备份下载）
  if (req.method === 'GET' && u.pathname.startsWith('/out/')) {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(png);
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

  // 配置并启动控制台（独立端口 + 独立数据库 + 独立 artifacts 目录）
  process.env.PORT = String(APP_PORT);
  process.env.DB_PATH = TEST_DB;
  process.env.DATA_DIR = TEST_ARTIFACTS;
  require('../server');
  // 轮询等待就绪（取代固定 sleep，消除慢机器/CI 上首检 ECONNREFUSED 的 flaky）
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { up = (await fetch(APP_BASE + '/api/health')).ok; } catch { await sleep(200); }
  }
  if (!up) err('控制台未能在 10 秒内完成启动');
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
  ok('元数据 /api/meta：模型/画幅/时长/图片清单完整');

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
  if (bad1.status !== 400 || !String(bad1.data.error).includes('text 模式')) err(`text 模式携带图片未被拦截: ${JSON.stringify(bad1.data)}`);
  ok('校验：text 模式携带媒体被 400 拒绝（含错误信息）');

  // 7. 校验规则：flash + 视频参考 → 400
  const bad2 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'reference',
    videos: ['https://example.com/a.mp4'],
  });
  if (bad2.status !== 400 || !String(bad2.data.error).includes('videos')) err(`flash 视频参考未被拦截: ${JSON.stringify(bad2.data)}`);
  ok('校验：Flash 模型 videos 被 400 拒绝（含错误信息）');

  // 8. 校验规则：reference 无素材 → 400
  const bad3 = await api('POST', '/api/tasks', {
    model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'reference',
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

  // ================= 流水线全链路（创意→文案→角色图→视频） =================
  // 16. 创建项目
  const proj = await api('POST', '/api/projects', {
    name: '黄昏麦田少年', idea: '黄昏麦田，穿黄胶鞋的少年走向远方', style: '电影写实',
    aspect_ratio: '16:9', seconds: '8',
  });
  if (proj.status !== 201 || !proj.data.id) err(`创建项目失败: ${JSON.stringify(proj.data)}`);
  const pid = proj.data.id;
  ok(`创建项目 #${pid}（${proj.data.name}）`);

  // 17. 文案生成（文本模型 → 结构化 JSON 落库）
  const scr = await api('POST', '/api/llm/script', {
    idea: '黄昏麦田少年走向远方', style: '电影写实', aspect_ratio: '16:9', seconds: '8', project_id: pid,
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
  if (pBad1.status !== 400 || !String(pBad1.data.error).includes('名称')) err(`项目空名称未被拦截: ${JSON.stringify(pBad1.data)}`);
  const pBad2 = await api('POST', '/api/projects', { name: 'x', aspect_ratio: '7:3' });
  if (pBad2.status !== 400 || !String(pBad2.data.error).includes('aspect_ratio')) err(`项目非法画幅未被拦截: ${JSON.stringify(pBad2.data)}`);
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
  if (pBad3.status !== 400 || !String(pBad3.data.error).includes('status')) err(`非法 status 未被拦截: ${JSON.stringify(pBad3.data)}`);
  const pBad4 = await api('PATCH', `/api/projects/${pid}`, { name: '   ' });
  if (pBad4.status !== 400) err('空名称 PATCH 未被拦截');
  ok('项目 PATCH：正常更新生效，非法 status / 空 name 被 400 拒绝');

  // 18. 角色图生成（图片模型 → CDN URL + 本地备份）
  const img = await api('POST', '/api/images/generate', {
    prompt: '角色立绘：银发少年', size: '1K', ratio: '1:1', project_id: pid, kind: 'character',
  });
  if (img.status !== 200 || !img.data.remote_url) err(`角色图生成失败: ${JSON.stringify(img.data).slice(0, 300)}`);
  if (!img.data.image?.selected) err('角色图未自动定稿');
  ok(`角色图生成并定稿 #${img.data.image.id}（remote=${img.data.remote_url} local=${img.data.local_url || '无'}）`);

  // 18.1 图片选用 + 删除图片
  const selI = await api('POST', `/api/projects/${pid}/select-image`, { image_id: img.data.image.id });
  if (selI.status !== 200 || !selI.data.ok) err(`选用图片失败: ${JSON.stringify(selI.data)}`);
  const img2 = await api('POST', '/api/images/generate', {
    prompt: '场景概念图：黄昏麦田', size: '1K', ratio: '16:9', project_id: pid, kind: 'scene',
  });
  if (img2.status !== 200 || !img2.data.image?.id) err(`第二张图片生成失败: ${JSON.stringify(img2.data).slice(0, 200)}`);
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

  // 21. 删除项目（级联清理 + 任务解绑）
  const delR = await api('DELETE', `/api/projects/${pid}`);
  if (delR.status !== 200 || !delR.data.ok) err(`删除项目失败: ${JSON.stringify(delR.data)}`);
  const delAgain = await api('DELETE', `/api/projects/${pid}`);
  if (delAgain.status !== 404) err('重复删除项目未被 404 拒绝');
  const afterDel = await api('GET', `/api/projects/${pid}`);
  if (afterDel.status !== 404) err('删除后项目详情仍可访问');
  const pvAfterDel = await api('GET', `/api/tasks/${pv.data.id}`);
  if (pvAfterDel.status !== 200 || pvAfterDel.data.project_id !== null) {
    err(`删除项目后视频任务应保留且解除关联: ${JSON.stringify({ status: pvAfterDel.status, project_id: pvAfterDel.data?.project_id })}`);
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

  // 10.2 重试端点：404 / 仅失败态可重试
  const retry404 = await api('POST', '/api/tasks/999999/retry', {});
  if (retry404.status !== 404) err('重试不存在的任务未被 404 拒绝');
  const retryBad = await api('POST', `/api/tasks/${taskId}/retry`, {});
  if (retryBad.status !== 400 || !String(retryBad.data.error).includes('仅 failed')) {
    err(`completed 任务重试未被 400 拦截: ${JSON.stringify(retryBad.data)}`);
  }
  ok('校验：重试 404 / completed 任务不可重试');

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
    model: 'agnes-video-2.5-flash', prompt: '待删除任务', mode: 'text', seconds: '5', size: '720P', aspect_ratio: '16:9',
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
  if (bulkF.status !== 200 || typeof bulkF.data.removed !== 'number') err(`清空失败任务异常: ${JSON.stringify(bulkF.data)}`);
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
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { fs.rmSync(TEST_ARTIFACTS, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试崩溃:', e);
  process.exit(1);
});