'use strict';
/**
 * payloads 单元测试 —— API 参数校验矩阵（上游 payload 正确性的核心防线）
 * 覆盖 buildV25Payload / buildImagePayload / URL 清洗工具（V2.0 已于 2026-09-25 下线，相关用例移除）。
 */
const {
  buildV25Payload,
  buildImagePayload,
  cleanUrlList,
  cleanVideoList,
  isHttpUrl,
  safeUrl,
} = require('../../services/payloads');
const { ApiError } = require('../../core/errors');

/** 断言给定调用抛出指定状态的 ApiError */
function expectApiError(status, fn) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(status);
}

describe('isHttpUrl / safeUrl', () => {
  test('isHttpUrl 只接受 http(s)', () => {
    expect(isHttpUrl('https://a.com/x.jpg')).toBe(true);
    expect(isHttpUrl('http://a.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('ftp://a.com')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });

  test('safeUrl 异常 scheme 置 null', () => {
    expect(safeUrl('https://ok.com/a.mp4')).toBe('https://ok.com/a.mp4');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:image/png;base64,xxx')).toBeNull();
  });
});

describe('cleanUrlList', () => {
  test('undefined/null/空串 返回空数组', () => {
    expect(cleanUrlList(undefined)).toEqual([]);
    expect(cleanUrlList(null)).toEqual([]);
    expect(cleanUrlList('')).toEqual([]);
  });

  test('过滤空串、保留合法 URL', () => {
    expect(cleanUrlList(['https://a.com/1.jpg', '', '  ', 'https://a.com/2.jpg'], 'images')).toEqual([
      'https://a.com/1.jpg',
      'https://a.com/2.jpg',
    ]);
  });

  test('非数组与非法 URL 抛 400', () => {
    expectApiError(400, () => cleanUrlList('https://a.com', 'images'));
    expectApiError(400, () => cleanUrlList(['ftp://bad.com'], 'images'));
  });
});

describe('cleanVideoList', () => {
  test('字符串 URL 转对象并补默认字段', () => {
    expect(cleanVideoList(['https://a.com/v.mp4'])).toEqual([
      { url: 'https://a.com/v.mp4', start_seconds: 0, require_audio: false },
    ]);
  });

  test('对象元素保留 start_seconds / require_audio', () => {
    const out = cleanVideoList([{ url: 'https://a.com/v.mp4', start_seconds: 2.5, require_audio: true }]);
    expect(out).toEqual([{ url: 'https://a.com/v.mp4', start_seconds: 2.5, require_audio: true }]);
  });

  test('非法元素抛 400', () => {
    expectApiError(400, () => cleanVideoList([42]));
    expectApiError(400, () => cleanVideoList([{ noUrl: true }]));
    expectApiError(400, () => cleanVideoList(['javascript:alert(1)']));
  });
});

describe('buildV25Payload（2.5 家族）', () => {
  const base = { prompt: '一段测试提示词', model: 'agnes-video-2.5-flash' };

  test('text 模式正常构建', () => {
    const { payload, meta } = buildV25Payload({ ...base, seconds: '6' });
    expect(payload).toMatchObject({
      model: 'agnes-video-2.5-flash',
      prompt: base.prompt,
      mode: 'text',
      seconds: '6',
      size: '720P',
      aspect_ratio: '16:9',
      n: 1,
    });
    expect(payload.seed).toBeUndefined();
    expect(meta.mode).toBe('text');
  });

  test('空 prompt 抛 400', () => expectApiError(400, () => buildV25Payload({ ...base, prompt: '   ' })));

  test('非法 mode / seconds / aspect_ratio / seed 抛 400', () => {
    expectApiError(400, () => buildV25Payload({ ...base, mode: 'video' }));
    expectApiError(400, () => buildV25Payload({ ...base, seconds: '3' }));
    expectApiError(400, () => buildV25Payload({ ...base, seconds: '13' }));
    expectApiError(400, () => buildV25Payload({ ...base, aspect_ratio: '5:4' }));
    expectApiError(400, () => buildV25Payload({ ...base, seed: -1 }));
    expectApiError(400, () => buildV25Payload({ ...base, seed: 1.5 }));
  });

  test('text 模式携带任意媒体字段抛 400', () => {
    expectApiError(400, () => buildV25Payload({ ...base, images: ['https://a.com/i.jpg'] }));
    expectApiError(400, () => buildV25Payload({ ...base, audios: ['https://a.com/a.mp3'] }));
    expectApiError(400, () => buildV25Payload({ ...base, videos: ['https://a.com/v.mp4'] }));
    expectApiError(400, () => buildV25Payload({ ...base, first_frame: 'https://a.com/f.jpg' }));
  });

  test('keyframe 模式：需要首尾帧至少一个，且不允许 images', () => {
    expectApiError(400, () => buildV25Payload({ ...base, mode: 'keyframe' }));
    expectApiError(400, () => buildV25Payload({ ...base, mode: 'keyframe', first_frame: 'ftp://bad.com/f.jpg' }));
    expectApiError(400, () =>
      buildV25Payload({
        ...base,
        mode: 'keyframe',
        first_frame: 'https://a.com/f.jpg',
        images: ['https://a.com/i.jpg'],
      }),
    );
    const { payload } = buildV25Payload({ ...base, mode: 'keyframe', first_frame: 'https://a.com/f.jpg' });
    expect(payload.first_frame).toBe('https://a.com/f.jpg');
    expect(payload.last_frame).toBeUndefined();
  });

  test('reference 模式：Flash 不允许视频参考、图片最多 5 张', () => {
    expectApiError(400, () => buildV25Payload({ ...base, mode: 'reference' }));
    expectApiError(400, () => buildV25Payload({ ...base, mode: 'reference', videos: ['https://a.com/v.mp4'] }));
    expectApiError(400, () =>
      buildV25Payload({
        ...base,
        mode: 'reference',
        images: ['1', '2', '3', '4', '5', '6'].map((i) => `https://a.com/${i}.jpg`),
      }),
    );
    const { payload } = buildV25Payload({ ...base, mode: 'reference', images: ['https://a.com/i.jpg'] });
    expect(payload.images).toEqual(['https://a.com/i.jpg']);
  });

  test('付费 2.5 模型允许视频参考', () => {
    const { payload } = buildV25Payload({
      ...base,
      model: 'agnes-video-2.5',
      mode: 'reference',
      videos: ['https://a.com/v.mp4'],
    });
    expect(payload.videos).toEqual([{ url: 'https://a.com/v.mp4', start_seconds: 0, require_audio: false }]);
  });

  test('seed 合法时进入 payload', () => {
    const { payload } = buildV25Payload({ ...base, seed: 12345 });
    expect(payload.seed).toBe(12345);
  });
});

describe('buildImagePayload', () => {
  const base = { prompt: '一张角色立绘' };

  test('默认 1K / 1:1 文生图', () => {
    const { payload, size, ratio, inputImages } = buildImagePayload(base);
    expect(payload).toMatchObject({ model: 'agnes-image-2.5-flash', prompt: base.prompt, size: '1K' });
    expect(payload.extra_body.response_format).toBe('url');
    expect(payload.ratio).toBeUndefined(); // ratio 未显式传时不下发
    expect(size).toBe('1K');
    expect(ratio).toBeNull();
    expect(inputImages).toEqual([]);
  });

  test('空 prompt 与超长 prompt 抛 400', () => {
    expectApiError(400, () => buildImagePayload({ prompt: '' }));
    expectApiError(400, () => buildImagePayload({ prompt: 'x'.repeat(8001) }));
  });

  test('size 白名单与自定义尺寸上限', () => {
    expect(buildImagePayload({ ...base, size: '2K' }).size).toBe('2K');
    expect(buildImagePayload({ ...base, size: '1024x768' }).size).toBe('1024x768');
    expectApiError(400, () => buildImagePayload({ ...base, size: '99999x1' }));
    expectApiError(400, () => buildImagePayload({ ...base, size: 'abc' }));
  });

  test('ratio 白名单校验', () => {
    expectApiError(400, () => buildImagePayload({ ...base, ratio: '5:4' }));
    const { payload } = buildImagePayload({ ...base, ratio: '16:9' });
    expect(payload.ratio).toBe('16:9');
  });

  test('输入图支持 http(s) 与 data:image，上限 5 张', () => {
    const ok = buildImagePayload({ ...base, image: ['https://a.com/a.jpg', 'data:image/png;base64,xxx', ''] });
    expect(ok.inputImages).toEqual(['https://a.com/a.jpg', 'data:image/png;base64,xxx']);
    expect(ok.payload.extra_body.image).toHaveLength(2);
    expectApiError(400, () => buildImagePayload({ ...base, image: 'https://a.com/a.jpg' })); // 必须数组
    expectApiError(400, () => buildImagePayload({ ...base, image: ['ftp://bad.com/a.jpg'] }));
    expectApiError(400, () =>
      buildImagePayload({ ...base, image: ['1', '2', '3', '4', '5', '6'].map((i) => `https://a.com/${i}.jpg`) }),
    );
  });
});
