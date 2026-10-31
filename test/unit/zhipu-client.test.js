'use strict';
/**
 * clients/zhipu.js 纯函数单测（v2.7）
 *
 * 为什么单独测：智谱是异步任务 + 大写状态枚举，上游字段一旦漂移，
 * 出错方式往往是「静默把有片当排队」或「拿 request_id 去查任务」。这些纯函数是唯一防线。
 */
const zhipu = require('../../clients/zhipu');

describe('normalizeBaseUrl', () => {
  test('裸域名补 https、去尾斜杠', () => {
    expect(zhipu.normalizeBaseUrl('open.bigmodel.cn')).toBe('https://open.bigmodel.cn');
    expect(zhipu.normalizeBaseUrl('https://open.bigmodel.cn/')).toBe('https://open.bigmodel.cn');
    expect(zhipu.normalizeBaseUrl('  http://127.0.0.1:8080  ')).toBe('http://127.0.0.1:8080');
  });

  test('粘贴完整接口地址时剥到根（用户常直接复制文档 URL）', () => {
    expect(zhipu.normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4/videos/generations')).toBe(
      'https://open.bigmodel.cn',
    );
    expect(zhipu.normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4/')).toBe('https://open.bigmodel.cn');
  });

  test('空值回落官方地址', () => {
    expect(zhipu.normalizeBaseUrl('')).toBe('https://open.bigmodel.cn');
    expect(zhipu.normalizeBaseUrl(null)).toBe('https://open.bigmodel.cn');
  });
});

describe('extractTaskId', () => {
  test('认 id / task_id，忽略 request_id（链路 id 不能用来查结果）', () => {
    expect(zhipu.extractTaskId({ id: 'task-1', request_id: 'req-1' })).toBe('task-1');
    expect(zhipu.extractTaskId({ task_id: 'task-2' })).toBe('task-2');
    expect(zhipu.extractTaskId({ request_id: 'req-1' })).toBeNull();
    expect(zhipu.extractTaskId({ id: '' })).toBeNull();
    expect(zhipu.extractTaskId(null)).toBeNull();
    expect(zhipu.extractTaskId('oops')).toBeNull();
  });

  test('数字 id 转字符串（上游出现过纯数字 id）', () => {
    expect(zhipu.extractTaskId({ id: 12345 })).toBe('12345');
  });
});

describe('extractVideoUrl', () => {
  test('标准位置：video_result[0].url', () => {
    expect(zhipu.extractVideoUrl({ video_result: [{ url: 'https://cdn/x.mp4' }] })).toBe('https://cdn/x.mp4');
  });

  test('历史漂移位置逐层兜底', () => {
    expect(zhipu.extractVideoUrl({ video_url: 'https://cdn/a.mp4' })).toBe('https://cdn/a.mp4');
    expect(zhipu.extractVideoUrl({ url: 'https://cdn/b.mp4' })).toBe('https://cdn/b.mp4');
    expect(zhipu.extractVideoUrl({ result: { url: 'https://cdn/c.mp4' } })).toBe('https://cdn/c.mp4');
    expect(zhipu.extractVideoUrl({ data: { url: 'https://cdn/d.mp4' } })).toBe('https://cdn/d.mp4');
    expect(zhipu.extractVideoUrl({ videos: [{ url: 'https://cdn/e.mp4' }] })).toBe('https://cdn/e.mp4');
  });

  test('非 http(s) 或缺失 → null（不把异常字符串塞进前端链接）', () => {
    expect(zhipu.extractVideoUrl({ url: 'javascript:alert(1)' })).toBeNull();
    expect(zhipu.extractVideoUrl({ video_result: [{}] })).toBeNull();
    expect(zhipu.extractVideoUrl(null)).toBeNull();
  });
});

describe('normalizeStatus', () => {
  test('大写枚举 → 四态', () => {
    expect(zhipu.normalizeStatus({ task_status: 'SUCCESS' })).toBe('completed');
    expect(zhipu.normalizeStatus({ task_status: 'FAIL' })).toBe('failed');
    expect(zhipu.normalizeStatus({ task_status: 'PROCESSING' })).toBe('in_progress');
    expect(zhipu.normalizeStatus({ status: 'queued' })).toBe('queued');
  });

  test('未知/缺失状态 → null（调用方按 queued 继续轮询，绝不误判失败）', () => {
    expect(zhipu.normalizeStatus({ task_status: 'WHATEVER' })).toBeNull();
    expect(zhipu.normalizeStatus({})).toBeNull();
  });
});

describe('classifyError', () => {
  const kind = (r) => zhipu.classifyError(r).kind;
  const retryable = (r) => zhipu.classifyError(r).retryable;

  test('鉴权失败不可重试（用户需改 Key）', () => {
    expect(kind({ status: 401 })).toBe('auth');
    expect(kind({ status: 403 })).toBe('auth');
    expect(retryable({ status: 401 })).toBe(false);
  });

  test('限流/并发可重试', () => {
    expect(kind({ status: 429 })).toBe('rate-limit');
    expect(retryable({ status: 429 })).toBe(true);
    expect(kind({ status: 400, data: { error: { message: '并发数超限，请稍后重试' } } })).toBe('rate-limit');
  });

  test('余额不足 / 内容审核 / 参数错误不可重试', () => {
    expect(kind({ status: 400, data: { error: { message: '账户余额不足' } } })).toBe('quota');
    expect(kind({ status: 400, data: { error: { message: '内容审核未通过' } } })).toBe('content-policy');
    expect(kind({ status: 400, data: { error: { message: 'invalid parameter' } } })).toBe('bad-args');
    expect(retryable({ status: 400 })).toBe(false);
  });

  test('5xx 与队列繁忙可重试；404 不可重试', () => {
    expect(kind({ status: 503 })).toBe('server');
    expect(retryable({ status: 502 })).toBe(true);
    expect(kind({ status: 400, data: { error: { message: '队列已满' } } })).toBe('queue-full');
    expect(kind({ status: 404 })).toBe('not-found');
    expect(retryable({ status: 404 })).toBe(false);
  });

  test('message 取上游文案，缺失时回落 statusText/HTTP 码', () => {
    expect(zhipu.classifyError({ status: 400, data: { error: { code: 'x1', message: '参数不合法' } } }).message).toBe(
      '参数不合法',
    );
    expect(zhipu.classifyError({ status: 500, statusText: 'Internal Server Error', data: null }).message).toBe(
      'Internal Server Error',
    );
  });
});
