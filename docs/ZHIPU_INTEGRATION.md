# 智谱 BigModel CogVideoX 接入说明（第三家视频上游）

> 版本：v2.7.2（2026-11-01）· 相关代码：`clients/zhipu.js`、`services/payloads.js`（`buildZhipuPayload`）、
> `workers/submitter.js`（`submitZhipu` / `planZhipuRetry` 限流等待预算 / `shouldZhipuPaidFallback` 自动改投）、
> `workers/poller.js`（`pollZhipu`）、`core/constants.js`（`providerOf`）。

## 1. 为什么接它

2026-10-31 对 Agnes 免费档的实测结论（详见 `AGENTS.md` 调度策略段）：

| 观察                                                     | 结果                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST https://apihub.agnes-ai.com/v1/videos`（flash/5s） | `503 {"code":"video_queue_full", ...}`，无 task id —— 每次提交都这样，不是偶发 |
| `agnes-video-v2.0`（另一免费档）                         | 官方公告已于 **2026-09-25** 下线                                               |
| `GET /v1/models`、`GET /agnesapi`、Key 本身              | 全部 200 / 正常报错 —— **不是配置坏了**，是免费档实际不可用                    |

智谱 **CogVideoX-Flash** 在官方文档的「免费模型」表里（长期免费档，不是限时赠额），且是标准异步任务 API
（创建 → 轮询），与既有提交器/轮询器模型天然契合，因此作为新视频主力。

**代价（选择它就必须接受）**：时长只有 5/10 秒、画幅只有 16:9 / 9:16 / 1:1、不支持多图参考（降级首帧）、
prompt ≤ 512 字、无音轨。需要 4/6/8/9/11/12 秒、4:3/3:4/21:9、或真正的多图参考时，手动切回 Agnes 模型。

## 2. 上游分发是怎么接进去的（零 schema / 零新路由）

| 位置                                                | 作用                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/constants.providerOf(model)`                  | 唯一分水岭：`DREAMINA_MODELS` → `dreamina`；`ZHIPU_MODELS` → `zhipu`；**其余一律 `agnes`**（未知模型归 Agnes 保证历史数据兼容）                                            |
| `services/payloads.buildPayload(body)`              | 分发顺序必须 **dreamina → zhipu → RETIRED → MODELS 兜底 → buildV25Payload**；智谱分支在 `MODELS` 兜底之前，否则第三方模型会被**静默改写成默认 Agnes 模型**（真实扣费事故） |
| `workers/submitter.submitOne(t)`                    | 顶部 `providerOf(t.model)` 分流；`submitZhipu` 成功时把远端 id **同时写进 `task_id` 与 `video_id`**                                                                        |
| `db/sql.js` 的 `activeTasks` / `pendingSubmitTasks` | 只看 `video_id` 是否为空来分「待提交 / 待轮询」——因此写 `video_id` 即自动接入轮询，**无需改任何 SQL**                                                                      |
| `workers/poller._pollOneInner(t)`                   | 同上分流到 `pollZhipu`，完成时复用既有 `downloadAndArchive` + 归档重试                                                                                                     |
| `tasks` 表                                          | **没有 provider 列**。上游由 `model` 读时推导；`request_json` 里额外留 `provider:'zhipu'` 作软标记（排查用，不参与判断）                                                   |

## 3. 智谱接口契约

创建（异步）：

```http
POST {base_url}/api/paas/v4/videos/generations
Authorization: Bearer <API Key>
Content-Type: application/json
```

```json
{
  "model": "cogvideox-flash",
  "prompt": "雪夜街角，红色邮筒上落满雪",
  "size": "1280x720",
  "duration": "5",
  "quality": "speed",
  "with_audio": false,
  "watermark_enabled": true,
  "fps": 30,
  "image_url": ["https://.../first-frame.png"]
}
```

响应：`{ "id": "…", "model": "cogvideox-flash", "request_id": "…", "task_status": "PROCESSING" }`

查询：

```http
GET {base_url}/api/paas/v4/async-result/{id}
```

响应：`{ "id","request_id","created","model","choices","usage","video_result":[{"url":"…","cover_image_url":"…"}],"content_filter" }`，
状态在 `task_status`（`PROCESSING` / `SUCCESS` / `FAIL`），错误为 `{ "error": { "code": "…", "message": "…" } }`。

字段映射（`buildZhipuPayload` 已实现）：

| 内部语义                    | 智谱字段                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `model`                     | `cogvideox-flash`（免费）/ `cogvideox-2`（付费 0.5 元/条，自动兜底）/ `cogvideox-3`（付费 1 元/条）                 |
| `seconds`（4–12）           | `duration`：≤7 → `5`，>7 → `10`（留 warning）                                                                       |
| `aspect_ratio`              | `size`：16:9→`1280x720`、9:16→`720x1280`、1:1→`1024x1024`；显式传智谱支持的 `size` 时以显式为准；4:3/3:4/21:9 → 400 |
| `mode: text`                | 不带 `image_url`                                                                                                    |
| `mode: keyframe`            | `image_url` = [首帧(, 尾帧)]，至少一张                                                                              |
| `mode: reference`（1–5 张） | **降级**：取 `images[0]` 作首帧，其余留 warning（智谱无多图参考）                                                   |
| `audios` / `videos`         | 明确 400（不支持）                                                                                                  |
| `prompt`                    | 超过 512 字截断并留 warning                                                                                         |
| 音轨                        | `with_audio:false` —— 声音由本地 TTS + BGM 合成                                                                     |

**任务号**只认响应里的 `id`（`extractTaskId` 也接受 `task_id`/`taskId`）；**绝不能用 `request_id`** 去查结果
（智谱两者都有，混用会 404）。

> **实测坑（2026-11-01，19/19 条证实）**：`cogvideox-2` 即便请求 `duration: "10"`，返回的视频也只有 **5.19 秒**
> （`ffprobe` 实测 5.193548s）——`duration` 字段被接受但不生效，当前账号/模型只出 5 秒；`cogvideox-flash` 同样是 5 秒档。
> 因此「10 秒镜头」只有两条路：① 换 `cogvideox-3`（1 元/条，原生 10 秒）；② 后期把 5 秒素材插帧慢放到 10 秒
> （本仓库《我是一条河》3 分钟短片即用
> `ffmpeg -vf "setpts=1.925*PTS,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"`，
> 19 镜并行 6 路约 3 分钟完成，画面变慢动作但观感顺畅）。
> 不要指望 `buildZhipuPayload` 的 `>7 → 10` 映射能拿到 10 秒成片——它只决定请求参数，不决定上游实际出片时长。

## 4. 设置项（控制台 → 设置 → 智谱 CogVideoX）

| 键                         | 默认                       | 说明                                                                                                                                                                |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zhipu_enabled`            | `1`                        | **一级 kill switch**。`0` = 提交器/轮询器保留任务不动（不判失败），恢复后自动继续                                                                                   |
| `zhipu_base_url`           | `https://open.bigmodel.cn` | 会归一化：补 https、去尾斜杠、剥掉 `/api/paas/v4/*`                                                                                                                 |
| `zhipu_api_key`            | 空                         | 控制台只回显 `sk-…****后四位`，留空保存 = 不改                                                                                                                      |
| `zhipu_model`              | `cogvideox-flash`          | 新建任务未指定模型时的默认档                                                                                                                                        |
| `zhipu_quality`            | `speed`                    | `speed` / `quality`                                                                                                                                                 |
| `zhipu_watermark`          | `1`                        | 是否让上游烧水印                                                                                                                                                    |
| `zhipu_max_active_minutes` | `30`                       | 轮询超时（超时判 `failed`）；**同时作为提交阶段限流等待预算的下限**：实际预算 = max(本值, 60) 分钟                                                                  |
| `zhipu_paid_fallback`      | `1`                        | v2.7.2：免费档连续 2 次容量限流（429/1305 或 queue-full）时**自动改投 `cogvideox-2`（0.5 元/条）** 并立即重试；`0` = 只退避等待、不花钱。改投只发生一次、且不跨上游 |

**保存 Key 会顺带把默认模型切到 `cogvideox-flash`**（仅当当前默认还是 `agnes-video-2.5-flash` 时），避免用户填完 Key
却发现任务还派给已失效的 Agnes。想用 Agnes 时在设置里手动切回即可。

## 5. 排障表

| 现象                                                  | 判定（`classifyError`） | 处理                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401/403`、`code` 含 `auth`/`invalid api key`         | `auth`（不可重试）      | Key 填错/被删 —— 重填并点「测试」                                                                                                                                                                                                                                                                                                       |
| `429`、`code` 含 `rate`/`concurrency`/并发            | `rate-limit`（可重试）  | 免费档限速，按退避等待即可；别急着关 `zhipu_enabled`（关了只会停手）                                                                                                                                                                                                                                                                    |
| `429` + `code=1305`「该模型当前访问量过大」持续很久   | `rate-limit`（可重试）  | **免费档容量紧张，不是 Key/参数问题**（实测可从晚间持续到次日早上 >11 小时）。v2.7.1 起按等待预算（≥60 分钟）退避；**v2.7.2 起连续 2 次后自动改投 `cogvideox-2`（0.5 元/条）并立即重试**，任务 `model` 变为 `cogvideox-2`、`error_message` 写明已改投。不想花钱：设置里关 `zhipu_paid_fallback`（只等待），或手动切 `cogvideox-3`/Agnes |
| `>=500`、`code` 含 `server`/`internal`                | `server`（可重试）      | 上游抖动，按等待预算退避重试（同 429 行）                                                                                                                                                                                                                                                                                               |
| `code` 含 `quota`/`余额`/`insufficient`               | `quota`（不可重试）     | 付费档余额不足；切回 `cogvideox-flash`                                                                                                                                                                                                                                                                                                  |
| `code` 含 `content`/`policy`/`审核`/`sensitive`       | `content-policy`        | 改提示词，重试无用                                                                                                                                                                                                                                                                                                                      |
| `code` 含 `invalid`/`parameter`、`1214`、prompt 为空  | `bad-args`              | 检查时长 / 画幅 / prompt ≤512                                                                                                                                                                                                                                                                                                           |
| `404`、`1211`、任务不存在                             | `not-found`             | 任务号错或上游已过期 —— 重新提交                                                                                                                                                                                                                                                                                                        |
| 任务一直 `processing` 超过 `zhipu_max_active_minutes` | —                       | 判 `failed`，可直接重试                                                                                                                                                                                                                                                                                                                 |

## 6. 验证方式

```bash
npm run test:unit              # 18 套件 / 314 用例（含 zhipu-client、payload 分发、限流等待预算与自动改投）
npm run test:mock              # e2e：mock 智谱上游建任务 → 提交 → PROCESSING → SUCCESS → 归档
npm test                       # 两者串跑（提交前必跑）
```

真实上游冒烟（**会消耗真实额度；`cogvideox-flash` 免费，`cogvideox-3` 会计费**）：

```bash
node -e "fetch('https://open.bigmodel.cn/api/paas/v4/videos/generations',{method:'POST',headers:{Authorization:'Bearer '+process.env.ZHIPU_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'cogvideox-flash',prompt:'雪夜街角，红色邮筒上落满雪',size:'1280x720',duration:'5',quality:'speed',with_audio:false,watermark_enabled:true,fps:30})}).then(r=>r.text()).then(console.log)"
```

> 中文 JSON 一律走 Node fetch，**不要用 PowerShell 的 `curl.exe`**（GBK 乱码，历史事故见 `AGENTS.md`）。

## 7. 以后再加第四家上游的清单

1. `core/constants.js`：加 `<UP>_MODELS` 表（每档给 `family/provider/sizes/durations/free/label`）+ 默认常量；
   `providerOf` 在 **agnes 兜底之前**加一支。
2. `clients/<up>.js`：照 `clients/zhipu.js` 四件套写 `request` / `createTask` / `queryTask` + 纯函数
   `normalizeBaseUrl`、`extractTaskId`、`extractVideoUrl`、`normalizeStatus`、`classifyError`（便于单测）。
3. `services/payloads.js`：加 `build<Up>Payload`，并在 `buildPayload` 的 `MODELS` 兜底**之前**插分支；
   记得 `module.exports` 补导出。
4. `workers/submitter.js` / `workers/poller.js`：各加一个分支 + `submit<Up>` / `poll<Up>`，成功时
   **远端 id 同时写 `task_id` 与 `video_id`**（轮询靠它接管）；错误按 `classifyError` 分档退避。
5. `db/repos/settings.js` 的 `DEFAULT_SETTINGS` 加设置键；`routes/settings.js` 加 GET/PUT 校验（Key 只回掩码）；
   `routes/meta.js` 加同构 `<up>` 块（**不要混进 `models`**）。
6. 前端：`public/task-meta.js` 加模型分组与 `onModelChange` 分支、`public/settings-panel.js` 加设置面板。
7. 测试：`test/unit/<up>-client.test.js` + `payloads.test.js` 分发用例；`test/mock-e2e.js` 加 mock 上游两条路由
   **和用例块（必须插在「批量清空后 removed>=3」断言之前）**。
8. 回滚顺序：先回退 workers，再 clients，最后 constants（避免「分发先于实现」的半截状态）。
