#!/usr/bin/env node
'use strict';
/**
 * tools/live-smoke.js —— 真上游冒烟（**会真实消耗 Agnes 额度**）
 *
 * 为什么需要：`npm run test:mock`（e2e）用的是 mock 上游，只证明「本机管线」通；
 * 部署到新机器/升级后，还需要一次**真上游**闭环来证明「提交 → 轮询 → 本地归档」确实跑通。
 * 本脚本就是那一次：建项目 → 建 1 个纯文生镜头 → 提交 → 轮询 → 核对归档文件与时长 → 清理。
 *
 * 用法：
 *   node tools/live-smoke.js                                  # 默认 http://127.0.0.1:8273
 *   AGNES_BASE=http://127.0.0.1:8274 node tools/live-smoke.js  # 指定实例（隔离实例联调用）
 *   node tools/live-smoke.js --model agnes-video-v2.0 --seconds 5 --timeout-min 20
 *   node tools/live-smoke.js --keep                            # 保留项目/任务（排查用）
 *
 * 退出码：0 = 出片并归档成功；1 = 上游失败或排队超时；2 = 调用出错
 * 提示：seconds 传**字符串**；数字入参自 v2.6.6 起由数据层护栏兜住，但脚本仍按真实前端形态传字符串。
 * 上游免费档繁忙时会返回 503「队列满」，此时任务会在队列里按 90/180/360/720s 退避重试 —— 属正常现象。
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function argOf(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const BASE = process.env.AGNES_BASE || 'http://127.0.0.1:8273';
const MODEL = argOf('--model', null);
const SECONDS = String(argOf('--seconds', '5'));
const TIMEOUT_MIN = Number(argOf('--timeout-min', '20'));
const KEEP = process.argv.includes('--keep');

const api = async (m, p, b) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: b ? { 'Content-Type': 'application/json' } : undefined,
    body: b ? JSON.stringify(b) : undefined,
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = text;
  }
  if (!r.ok) throw new Error(`${m} ${p} → HTTP ${r.status} ${String(text).slice(0, 250)}`);
  return j;
};

const t0 = Date.now();
const ts = () => `[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`;

(async () => {
  const health = await api('GET', '/api/health');
  console.log(ts(), `实例就绪: ${health.app} · ${health.node} · db=${health.db}`);
  if (!health.ok) throw new Error('实例未就绪');

  const p = await api('POST', '/api/projects', {
    name: `真上游冒烟-${new Date().toISOString().slice(0, 16)}`,
    aspect_ratio: '16:9',
    seconds: SECONDS,
  });
  const pid = p.id ?? p.project?.id;
  console.log(ts(), `项目 #${pid}（seconds=${p.seconds}）`);

  const shot = await api('POST', `/api/projects/${pid}/shots`, {
    title: '冒烟镜 01',
    video_prompt: '海边的白色灯塔，黄昏，云层缓慢流动，镜头极缓推近，日式赛璐璐动画风格，清晰墨线描边',
    narration: '灯塔在暮色里亮起',
    seconds: SECONDS,
    mode: 'text',
  });
  const sid = shot.id ?? shot.shot?.id;
  console.log(ts(), `镜头 #${sid}（seconds=${shot.seconds}）`);

  const submitted = await api('POST', `/api/projects/${pid}/shots/${sid}/videos`, MODEL ? { model: MODEL } : {});
  const tid = submitted.id ?? submitted.task?.id;
  console.log(ts(), `视频任务 #${tid}（model=${submitted.model ?? submitted.task?.model}）`);

  const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
  let last = '';
  let task = null;
  while (Date.now() < deadline) {
    task = await api('GET', `/api/tasks/${tid}`);
    const line = `status=${task.status} progress=${task.progress ?? 0} poll=${task.poll_count ?? 0} ${task.error_message || ''}`;
    if (line !== last) {
      console.log(ts(), '  ', line);
      last = line;
    }
    if (['completed', 'failed', 'submit_error'].includes(task.status)) break;
    await new Promise((r) => setTimeout(r, 15000));
  }

  console.log('\n===== 结果 =====');
  console.log('项目/镜头/任务 :', `${pid} / ${sid} / ${tid}`);
  console.log('最终状态       :', task.status);

  // 本地归档是**异步**的：poller 在任务完成后才下载远端产物（实测晚 2–4 秒，弱网更久）。
  // 完成后立刻读 video_local_path 会拿到空值、把成功误判成失败，故这里留一段宽限期。
  if (task.status === 'completed' && !task.video_local_path) {
    const graceEnd = Date.now() + 60 * 1000;
    while (Date.now() < graceEnd && !task.video_local_path) {
      await new Promise((r) => setTimeout(r, 3000));
      task = await api('GET', `/api/tasks/${tid}`);
    }
    if (task.video_local_path) console.log(ts(), '  ', `归档完成（异步）: ${task.video_local_path}`);
    else console.log(ts(), '  ', '等待归档超时（video_auto_download 关闭或下载失败）');
  }

  console.log('远端地址       :', task.metadata_url || '(无)');
  console.log('本地归档       :', task.video_local_path || '(无)');
  if (task.error_message) console.log('错误信息       :', task.error_message);

  let archived = false;
  if (task.video_local_path && fs.existsSync(task.video_local_path)) {
    archived = true;
    const st = fs.statSync(task.video_local_path);
    console.log('归档文件       :', `${(st.size / 1048576).toFixed(2)} MB`);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', task.video_local_path],
      { encoding: 'utf8' },
    );
    const dur = String(probe.stdout || '').trim();
    if (dur) console.log('时长（ffprobe）:', `${Number(dur).toFixed(2)}s`);
  }

  if (!KEEP) {
    try {
      await api('DELETE', `/api/projects/${pid}`);
      await api('DELETE', `/api/tasks/${tid}`);
      console.log('清理           : 项目与任务已删除（归档文件仍在 data/artifacts，需要时手动删）');
    } catch (e) {
      console.log('清理失败（不影响结论）:', e.message);
    }
  } else {
    console.log('清理           : 已跳过（--keep）');
  }

  if (task.status === 'completed' && archived) {
    console.log('\n✓ 真上游闭环通过：提交 → 轮询 → 本地归档');
    process.exit(0);
  }
  console.log('\n✗ 未完成（上游失败/排队超时）—— 可稍后重跑，或换档：--model agnes-video-v2.0');
  process.exit(1);
})().catch((e) => {
  console.error('冒烟失败:', e.message);
  process.exit(2);
});
