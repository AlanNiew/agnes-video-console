'use strict';
/**
 * 即梦（官方 dreamina CLI）接入单元测试
 * 覆盖：provider 推导、即梦 payload 校验矩阵、CLI argv 组装。
 * 全部为纯函数校验，不触网、不 spawn 子进程、不消耗积分。
 */
const { providerOf } = require('../../core/constants');
const {
  buildPayload,
  buildDreaminaPayload,
  buildImagePayload,
  buildDreaminaImagePayload,
} = require('../../services/payloads');
const { buildVideoArgs, buildImageArgs, extractImageUrls, extractVideoUrls } = require('../../clients/dreamina');
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

describe('providerOf（模型 → 上游 provider）', () => {
  test('即梦模型识别为 dreamina', () => {
    expect(providerOf('seedance2.0fast')).toBe('dreamina');
    expect(providerOf('seedance2.0')).toBe('dreamina');
    expect(providerOf('seedance2.5')).toBe('dreamina');
    expect(providerOf('seedance2.0_vip')).toBe('dreamina');
  });

  test('Agnes 模型与未知模型一律回退 agnes（保证历史数据与既有调用向后兼容）', () => {
    expect(providerOf('agnes-video-2.5-flash')).toBe('agnes');
    expect(providerOf('agnes-video-2.5')).toBe('agnes');
    expect(providerOf('agnes-video-v2.0')).toBe('agnes');
    expect(providerOf('some-unknown-model')).toBe('agnes');
    expect(providerOf(undefined)).toBe('agnes');
    expect(providerOf('')).toBe('agnes');
  });
});

describe('buildDreaminaPayload（即梦参数校验与组装）', () => {
  test('合法请求：payload/meta 结构与参数换算正确', () => {
    const { payload, meta } = buildDreaminaPayload({
      model: 'seedance2.0fast',
      prompt: '一只红球在木桌上缓慢滚动',
      duration: 5,
      video_resolution: '720p',
      ratio: '16:9',
    });
    expect(payload.provider).toBe('dreamina');
    expect(payload.subcommand).toBe('text2video');
    expect(payload.modelVersion).toBe('seedance2.0fast');
    expect(payload.prompt).toBe('一只红球在木桌上缓慢滚动');
    expect(payload.duration).toBe(5);
    expect(payload.videoResolution).toBe('720p');
    expect(payload.ratio).toBe('16:9');

    // meta 字段名刻意对齐 tasks 既有列，保证前端任务列表零改动即可显示
    expect(meta.model).toBe('seedance2.0fast');
    expect(meta.mode).toBe('text');
    expect(meta.seconds).toBe(5);
    expect(meta.size).toBe('720p');
    expect(meta.aspect_ratio).toBe('16:9');
  });

  test('seconds 别名兼容；缺省时长 5s、缺省分辨率取模型首项、不传画幅则交 CLI 默认', () => {
    const { payload } = buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x', seconds: 8 });
    expect(payload.duration).toBe(8);

    const { payload: dflt } = buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x' });
    expect(dflt.duration).toBe(5);
    expect(dflt.videoResolution).toBe('720p');
    expect(dflt.ratio).toBeNull();
  });

  test('prompt 缺失或超长 → 400', () => {
    expectApiError(400, () => buildDreaminaPayload({ model: 'seedance2.0fast', prompt: '   ' }));
    expectApiError(400, () =>
      buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x'.repeat(8001), duration: 5 }),
    );
  });

  test('不支持的模型 → 400', () => {
    expectApiError(400, () => buildDreaminaPayload({ model: 'seedance9.9', prompt: 'x' }));
    expectApiError(400, () => buildDreaminaPayload({ prompt: 'x' }));
  });

  test('时长越界（含非整数）→ 400', () => {
    expectApiError(400, () => buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x', duration: 3 }));
    expectApiError(400, () => buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x', duration: 16 }));
    expectApiError(400, () => buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x', duration: 5.5 }));
  });

  test('分辨率不在该模型白名单 → 400（seedance2.0fast 仅 720p）', () => {
    expectApiError(400, () =>
      buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x', video_resolution: '1080p' }),
    );
  });

  test('seedance2.5 允许 4-30s 与 480p/1080p；seedance2.0_vip 允许 1080p', () => {
    const { payload: p25 } = buildDreaminaPayload({
      model: 'seedance2.5',
      prompt: 'x',
      duration: 30,
      video_resolution: '1080p',
    });
    expect(p25.modelVersion).toBe('seedance2.5');
    expect(p25.duration).toBe(30);
    expect(p25.videoResolution).toBe('1080p');

    const { payload: vip } = buildDreaminaPayload({
      model: 'seedance2.0_vip',
      prompt: 'x',
      duration: 15,
      video_resolution: '1080p',
    });
    expect(vip.videoResolution).toBe('1080p');

    // 反向：2.5 不允许 4k、2.0fast_vip 按 CLI 说明仅 720p
    expectApiError(400, () => buildDreaminaPayload({ model: 'seedance2.5', prompt: 'x', video_resolution: '4k' }));
    expectApiError(400, () =>
      buildDreaminaPayload({ model: 'seedance2.0fast_vip', prompt: 'x', video_resolution: '1080p' }),
    );
  });

  test('画幅不在白名单 → 400；大小写不敏感的分辨率归一化', () => {
    expectApiError(400, () => buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x', ratio: '2:1' }));
    const { payload } = buildDreaminaPayload({ model: 'seedance2.0fast', prompt: 'x', size: '720P' });
    expect(payload.videoResolution).toBe('720p');
  });
});

describe('buildPayload 分发（即梦 vs Agnes）', () => {
  test('即梦模型走即梦分支，不会被降级成默认 Agnes 模型', () => {
    const { payload, meta } = buildPayload({
      model: 'seedance2.0fast',
      prompt: 'a cat walking',
      video_resolution: '720p',
    });
    expect(payload.provider).toBe('dreamina');
    expect(payload.subcommand).toBe('text2video');
    expect(meta.model).toBe('seedance2.0fast');
  });

  test('未指定模型时仍沿用 Agnes 默认模型（即梦不夺权）', () => {
    const { payload } = buildPayload({ prompt: 'a cat walking' });
    expect(payload.provider).toBeUndefined(); // Agnes payload 无 provider 字段
    expect(payload.model).toMatch(/^agnes-/);
  });
});

describe('buildVideoArgs（CLI argv 组装）', () => {
  test('参数映射为 --kebab 形式，且必填的 video_resolution 就位', () => {
    const args = buildVideoArgs({
      subcommand: 'text2video',
      prompt: 'hello world',
      duration: 5,
      ratio: '16:9',
      videoResolution: '720p',
      modelVersion: 'seedance2.0fast',
    });
    expect(args[0]).toBe('text2video');
    expect(args).toContain('--prompt=hello world');
    expect(args).toContain('--video_resolution=720p');
    expect(args).toContain('--duration=5');
    expect(args).toContain('--ratio=16:9');
    expect(args).toContain('--model_version=seedance2.0fast');
  });

  test('以 argv 数组传递（不经 shell），prompt 中的元字符原样保留为单一参数', () => {
    const args = buildVideoArgs({ prompt: 'a; rm -rf / && echo $(whoami)', videoResolution: '720p' });
    expect(args).toContain('--prompt=a; rm -rf / && echo $(whoami)');
  });

  test('缺省值：子命令默认 text2video，未给的参数不产生空 flag', () => {
    const args = buildVideoArgs({ prompt: 'x', videoResolution: '720p' });
    expect(args[0]).toBe('text2video');
    expect(args.some((a) => a.startsWith('--duration='))).toBe(false);
    expect(args.some((a) => a.startsWith('--ratio='))).toBe(false);
  });

  test('multimodal2video（全能参考）：reference 视频与音频映射为 --video / --audio', () => {
    const args = buildVideoArgs({
      subcommand: 'multimodal2video',
      prompt: '电影感短片',
      videoResolution: '720p',
      video: './ref.mp4',
      audio: './music.mp3',
      modelVersion: 'seedance2.0fast',
    });
    expect(args[0]).toBe('multimodal2video');
    expect(args).toContain('--video=./ref.mp4');
    expect(args).toContain('--audio=./music.mp3');
  });

  test('不支持的子命令直接抛错（防止参数白名单被绕过）', () => {
    expect(() => buildVideoArgs({ subcommand: 'rm-rf', prompt: 'x' })).toThrow();
  });
});

describe('buildDreaminaImagePayload（即梦图片参数校验）', () => {
  test('合法请求：payload 结构与参数换算正确', () => {
    const r = buildDreaminaImagePayload({
      model: 'jimeng-image-5.0',
      prompt: '一位少女站在麦田里',
      ratio: '1:1',
      size: '2k',
      count: 2,
    });
    expect(r.payload.provider).toBe('dreamina');
    expect(r.payload.subcommand).toBe('text2image');
    expect(r.payload.modelVersion).toBe('5.0');
    expect(r.payload.resolutionType).toBe('2k');
    expect(r.payload.generateNum).toBe(2);
    expect(r.model).toBe('jimeng-image-5.0');
    expect(r.size).toBe('2k');
  });

  test('缺省：分辨率取模型首项、count 默认 1、ratio 交给 CLI 默认', () => {
    const r = buildDreaminaImagePayload({ model: 'jimeng-image-3.1', prompt: 'x' });
    expect(r.payload.resolutionType).toBe('1k');
    expect(r.payload.generateNum).toBe(1);
    expect(r.payload.ratio).toBeNull();
  });

  test('prompt 缺失 / 模型非法 / 分辨率越权 / 画幅非法 → 400', () => {
    expectApiError(400, () => buildDreaminaImagePayload({ model: 'jimeng-image-5.0', prompt: '   ' }));
    expectApiError(400, () => buildDreaminaImagePayload({ model: 'jimeng-image-9.9', prompt: 'x' }));
    // 3.1 仅支持 1k/2k，4k 属越权
    expectApiError(400, () => buildDreaminaImagePayload({ model: 'jimeng-image-3.1', prompt: 'x', size: '4k' }));
    expectApiError(400, () => buildDreaminaImagePayload({ model: 'jimeng-image-5.0', prompt: 'x', ratio: '2:1' }));
  });

  test('5.0Pro 支持 1.5k，5.0 支持 4k', () => {
    const pro = buildDreaminaImagePayload({ model: 'jimeng-image-5.0pro', prompt: 'x', size: '1.5k' });
    expect(pro.payload.resolutionType).toBe('1.5k');
    const v50 = buildDreaminaImagePayload({ model: 'jimeng-image-5.0', prompt: 'x', size: '4k' });
    expect(v50.payload.resolutionType).toBe('4k');
  });
});

describe('buildImagePayload 分流（即梦异步 vs Agnes 同步）', () => {
  test('即梦图片模型走即梦分支，并返回 model 供路由入队', () => {
    const r = buildImagePayload({ model: 'jimeng-image-5.0', prompt: 'x' });
    expect(r.payload.provider).toBe('dreamina');
    expect(r.model).toBe('jimeng-image-5.0');
  });

  test('Agnes 路径行为不变，且返回值带 model（此前路由硬编码 IMAGE_MODEL）', () => {
    const r = buildImagePayload({ prompt: 'x' });
    expect(r.payload.model).toBe('agnes-image-2.5-flash');
    expect(r.model).toBe('agnes-image-2.5-flash');
    expect(r.payload.provider).toBeUndefined();
  });
});

describe('buildImageArgs（即梦图片 argv 组装）', () => {
  test('必填的 --resolution_type 就位，参数映射正确', () => {
    const args = buildImageArgs({
      prompt: 'a cat',
      resolutionType: '2k',
      ratio: '1:1',
      modelVersion: '5.0',
      generateNum: 4,
    });
    expect(args[0]).toBe('text2image');
    expect(args).toContain('--resolution_type=2k');
    expect(args).toContain('--prompt=a cat');
    expect(args).toContain('--generate_num=4');
  });

  test('width/height 必须成对（CLI 规定），单独给出不产生 flag', () => {
    const onlyWidth = buildImageArgs({ prompt: 'x', resolutionType: '1k', width: 1024 });
    expect(onlyWidth).not.toContain('--width=1024');
    const pair = buildImageArgs({ prompt: 'x', resolutionType: '1k', width: 1024, height: 768 });
    expect(pair).toContain('--width=1024');
    expect(pair).toContain('--height=768');
  });

  test('image2image（图生图）：参考图映射为 --images，多张逗号连接', () => {
    const args = buildImageArgs({
      subcommand: 'image2image',
      images: ['./a.png', './b.png'],
      resolutionType: '2k',
      prompt: '改成水彩风格',
    });
    expect(args[0]).toBe('image2image');
    expect(args).toContain('--images=./a.png,./b.png');
  });
});

describe('extractImageUrls / extractVideoUrls（即梦响应解析）', () => {
  test('实测主路径：result_json.images[].image_url（CLI v1.4.18 真实样本）', () => {
    const real = {
      submit_id: 'f3ba28da-a857-4557-aab9-59ee9b31e3cb',
      gen_status: 'success',
      credit_count: 1,
      result_json: {
        images: [
          { image_url: 'https://p11-dreamina-sign.byteimg.com/a.png', width: 1328, height: 1328 },
          { image_url: 'https://p11-dreamina-sign.byteimg.com/b.png', width: 1328, height: 1328 },
        ],
        videos: [],
      },
      queue_info: { queue_status: 'Finish' },
    };
    expect(extractImageUrls(real)).toEqual([
      'https://p11-dreamina-sign.byteimg.com/a.png',
      'https://p11-dreamina-sign.byteimg.com/b.png',
    ]);
  });

  test('extractVideoUrls 走同源约定（result_json.videos[].video_url）', () => {
    const real = { gen_status: 'success', result_json: { images: [], videos: [{ video_url: 'https://x.com/v.mp4' }] } };
    expect(extractVideoUrls(real)).toEqual(['https://x.com/v.mp4']);
  });

  test('兜底形态：数组字段 / 对象数组 / data 内嵌 / 顶层 / metadata', () => {
    expect(extractImageUrls({ image_urls: ['https://a.com/1.png'] })).toEqual(['https://a.com/1.png']);
    expect(extractImageUrls({ images: [{ url: 'https://a.com/2.png' }] })).toEqual(['https://a.com/2.png']);
    expect(extractImageUrls({ data: { images: ['https://a.com/3.png'] } })).toEqual(['https://a.com/3.png']);
    expect(extractImageUrls({ url: 'https://a.com/4.png' })).toEqual(['https://a.com/4.png']);
    expect(extractImageUrls({ metadata: { url: 'https://a.com/5.png' } })).toEqual(['https://a.com/5.png']);
  });

  test('去重并过滤非 http(s) 值', () => {
    expect(extractImageUrls({ images: ['https://a.com/1.png', 'https://a.com/1.png', 'ftp://x/1.png', ''] })).toEqual([
      'https://a.com/1.png',
    ]);
  });

  test('无有效地址时返回空数组（调用方据此落 failed 并保留原始响应）', () => {
    expect(extractImageUrls({})).toEqual([]);
    expect(extractImageUrls(null)).toEqual([]);
    expect(extractImageUrls({ gen_status: 'success' })).toEqual([]);
    expect(extractVideoUrls({ result_json: {} })).toEqual([]);
  });
});

/**
 * 衔接测试：payload（存 tasks.request_json）→ argv。
 * 教训：早期 snake_case 的 payload 喂给 camelCase 的 buildXxxArgs，字段静默丢失，
 * CLI 直接报 `required flag(s) "video_resolution"/"resolution_type" not set`，
 * 而「分开测两端」的单测无法发现——故必须测这一层衔接。
 */
describe('payload → argv 衔接（防字段名 snake_case / camelCase 不匹配）', () => {
  test('即梦视频：buildDreaminaPayload 的输出可直接喂给 buildVideoArgs', () => {
    const { payload } = buildDreaminaPayload({
      model: 'seedance2.0fast',
      prompt: '一只橘猫从沙发跳下',
      duration: 5,
      video_resolution: '720p',
      ratio: '16:9',
    });
    const args = buildVideoArgs(payload);
    expect(args[0]).toBe('text2video');
    // CLI 必填项：漏了会直接 bad-args 失败
    expect(args).toContain('--video_resolution=720p');
    expect(args).toContain('--model_version=seedance2.0fast');
    expect(args).toContain('--duration=5');
    expect(args).toContain('--prompt=一只橘猫从沙发跳下');
    expect(args).toContain('--ratio=16:9');
  });

  test('即梦图片：buildDreaminaImagePayload 的输出可直接喂给 buildImageArgs', () => {
    const { payload } = buildDreaminaImagePayload({
      model: 'jimeng-image-5.0',
      prompt: '少女站在麦田里',
      size: '2k',
      ratio: '1:1',
      count: 2,
    });
    const args = buildImageArgs(payload);
    expect(args[0]).toBe('text2image');
    expect(args).toContain('--resolution_type=2k'); // CLI 必填项，最易漏
    expect(args).toContain('--model_version=5.0');
    expect(args).toContain('--generate_num=2');
    expect(args).toContain('--prompt=少女站在麦田里');
  });
});
