'use strict';
/**
 * repo-seconds.test.js —— TEXT 列「seconds」的类型护栏（v2.6.6 实测缺陷的回归测试）
 *
 * 缺陷现场：直接调 API 传**数字** seconds（如 `{seconds: 5}`），node:sqlite 把 JS number 一律按
 * REAL 绑定，写进 TEXT 亲和列就成了字符串 '5.0'；而 services/payloads.js 的秒数白名单只认
 * '4'..'12'，于是这个镜头**永远提交不出去**（报「seconds 仅支持 "4"–"12"，收到：5.0」）。
 * 前端传的是字符串所以 477 条历史镜头都干净 —— 只有 API/脚本调用会踩到。
 * 护栏放在数据层：写库前统一 String()，一处覆盖所有调用方。
 */
const { projects, tasks } = require('../../db');
const { SECONDS_OK } = require('../../core/constants');

test('projects.insert：数字 seconds 落库为字符串', () => {
  const id = projects.insert({ name: '护栏测试', seconds: 5 });
  const p = projects.get(id);
  expect(p.seconds).toBe('5');
  expect(typeof p.seconds).toBe('string');
});

test('projects.insert：缺省 seconds 仍回退 "5"', () => {
  const id = projects.insert({ name: '护栏测试-默认' });
  expect(projects.get(id).seconds).toBe('5');
});

test('projects.update / addShot / updateShot：数字一律归一化', () => {
  const pid = projects.insert({ name: '护栏测试-镜头' });
  projects.update(pid, { seconds: 12 });
  expect(projects.get(pid).seconds).toBe('12');

  const sid = projects.addShot({ project_id: pid, seq: 1, video_prompt: 'p', seconds: 7 });
  expect(projects.shots(pid)[0].seconds).toBe('7');

  projects.updateShot(sid, { seconds: 4 });
  expect(projects.shots(pid)[0].seconds).toBe('4');
});

test('projects.bulkAddShots / replaceShots：数字一律归一化', () => {
  const pid = projects.insert({ name: '护栏测试-批量' });
  projects.bulkAddShots(pid, [{ video_prompt: 'a', seconds: 6 }]);
  expect(projects.shots(pid)[0].seconds).toBe('6');

  projects.replaceShots(pid, [{ seq: 1, video_prompt: 'b', seconds: 9 }]);
  expect(projects.shots(pid)[0].seconds).toBe('9');
});

test('tasks.insert / update：数字一律归一化', () => {
  const tid = tasks.insert({ status: 'queued', model: 'agnes-video-2.5-flash', prompt: 'p', seconds: 5 });
  expect(tasks.get(tid).seconds).toBe('5');

  tasks.update(tid, { seconds: 8 });
  expect(tasks.get(tid).seconds).toBe('8');
});

test('归一化后的值能直接通过上游白名单（不再出现 "5.0"）', () => {
  const id = projects.insert({ name: '护栏测试-白名单', seconds: 5 });
  expect(SECONDS_OK).toContain(projects.get(id).seconds);

  const sid = projects.addShot({ project_id: id, seq: 1, video_prompt: 'p', seconds: 10 });
  expect(sid).toBeGreaterThan(0);
  expect(SECONDS_OK).toContain(projects.shots(id)[0].seconds);
});
