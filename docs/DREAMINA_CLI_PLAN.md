# 即梦 CLI 集成开发计划

> **状态**：阶段 0（后端接入）已交付；阶段 1–6 待实施
> **分支**：`feature/dreamina-integration`（保留分支，后续开发在此进行）
> **相关文档**：`AGENTS.md`（架构约束）、`docs/BRANCHING.md`（分支/路径纪律）
> **最后更新**：2026-09-16

---

## 1. 背景与现状

### 1.1 为什么要接即梦

Agnes 免费档（`agnes-video-2.5-flash`）足以支撑**分镜视频**的量产，但在两类资产上力不从心：

- **角色图**：人物一致性是全片根基，免费模型的多候选质量不稳
- **封面/海报**：决定点击率，需要更强的图片模型
- **关键镜头**：个别镜头（情绪特写、转场）值得用更强的视频模型

而即梦会员额度**无法用于火山方舟 API**，但官方 `dreamina` CLI 恰好限会员使用、按会员积分计费——这正是可用的通道。

### 1.2 已完成（阶段 0，已合并 main）

| 能力                                                   | 位置                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| CLI 子进程包装（防 stdin 阻塞 + JSON 解析 + 错误分类） | `clients/dreamina.js`                                                          |
| 视频/图片模型清单与白名单                              | `core/constants.js` 的 `DREAMINA_MODELS` / `DREAMINA_IMAGE_MODELS`             |
| provider 推导（零 schema 变更）                        | `core/constants.js` 的 `providerOf()`                                          |
| 参数校验与组装                                         | `services/payloads.js` 的 `buildDreaminaPayload` / `buildDreaminaImagePayload` |
| 提交分流                                               | `workers/submitter.js`、`workers/image-worker.js`、`services/task-queue.js`    |
| 轮询分流（独立超时）                                   | `workers/poller.js` 的 `pollDreamina`                                          |
| 产物地址提取                                           | `clients/dreamina.js` 的 `extractImageUrls` / `extractVideoUrls`               |
| 单元测试 27 项                                         | `test/unit/dreamina.test.js`                                                   |

### 1.3 实测标定数据（成本模型的依据）

| 项目                               | 实测消耗                             | 备注                                                 |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| 图片 `jimeng-image-3.1` @ 1k       | **1 积分**                           | 一次请求返回 **4 张候选**（即便传 `generate_num:1`） |
| 视频 `seedance2.0fast` @ 720p / 5s | **25 积分**                          | 即 5 积分/秒                                         |
| 账号等级                           | `vip_level: standard`，`priority: 3` | 队列优先级偏低                                       |
| 排队实况                           | 提交后 **50 分钟以上**仍 `querying`  | `queue_length` 达数十万                              |

成功响应结构（实测样本）：

```json
{
  "submit_id": "f3ba28da-...",
  "gen_status": "success",
  "credit_count": 1,
  "result_json": {
    "images": [{ "image_url": "https://p11-dreamina-sign.byteimg.com/...png", "width": 1328, "height": 1328 }],
    "videos": []
  }
}
```

### 1.4 架构约束（不可违反）

1. **零 schema 变更**：provider 由 `model` 推导，即梦 `submit_id` 复用 `tasks.video_id` 列
2. **即梦模型不进 `/api/meta` 的 `models`**（当前实现），前端下拉不受影响
3. **Agnes 主链路不受任何影响**：即梦环境未就绪时任务保留 `queued` 退避，绝不判死
4. **ffmpeg/CLI 子进程纪律**：`stdio: ['ignore', 'pipe', 'pipe']`，杜绝等待 stdin 导致的永久挂起

---

## 2. 目标与设计原则

### 2.1 成本均衡（核心原则）

> **免费打主力，收费砸关键。** 学会均衡使用，这一点至关重要。

| 落点             | 默认走            | 理由                                                  |
| ---------------- | ----------------- | ----------------------------------------------------- |
| 分镜视频（量大） | Agnes 免费 Flash  | 735 积分 ≈ 29 条 5s 视频 vs ≈ 2940 张图，量级差即策略 |
| 角色图           | **即梦** `3.1`/1k | 1 积分得 4 张候选，成本可忽略                         |
| 封面 / 海报      | **即梦** `5.0`    | 点击率命脉，量少                                      |
| 关键镜头         | 手动升级即梦      | 由使用者判断                                          |

### 2.2 成本护栏（三档，本次新增要求）

**任何即梦调用都必须经过成本护栏**，按预估积分分三档：

| 档位         | 触发条件                       | 行为                                                          |
| ------------ | ------------------------------ | ------------------------------------------------------------- |
| **静默通过** | 预估积分 **≤ 阈值**（默认 10） | 直接提交，无打扰（覆盖全部图片场景）                          |
| **弹窗确认** | 预估积分 **> 阈值**            | 显示「预估 N 积分 · 剩余 M 积分」，需点击确认（覆盖视频场景） |
| **强阻断**   | 预估积分 **> 剩余积分**        | 禁止提交，提示改用免费模型或前往充值                          |

- 阈值可配：新增设置项 `dreamina_confirm_threshold`（默认 `10`）
- 阈值设为 `0` 表示「每次即梦调用都确认」，设为极大值表示「从不确认」
- **护栏只作用于即梦**（`providerOf(model) === 'dreamina'`），Agnes 调用零打扰

### 2.3 非侵入

- 即梦功能默认可用但不主动介入既有链路（`workers/auto.js` 除外，见阶段 6）
- 所有新增能力均可关闭：未安装 CLI / 未登录时，前端仅显示未就绪提示，不报错

---

## 3. 缺口清单

| 能力              | 现状                         | 目标                  | 阶段 |
| ----------------- | ---------------------------- | --------------------- | ---- |
| 即梦状态/积分可见 | 只能命令行 `user_credit`     | 设置页实时展示        | 1, 2 |
| 即梦登录          | 手动敲 CLI                   | 控制台内完成 OAuth    | 1, 2 |
| 成本预估          | 无                           | 单价表 + 预估函数     | 1, 3 |
| 成本护栏          | 无                           | 三档阈值（见 2.2）    | 1, 3 |
| 前端选模型        | 下拉只有 3 个 Agnes 模型     | 分组下拉（免费/收费） | 3    |
| 角色图用即梦      | 走**同步**接口，即梦直接 400 | 改异步 + 可选即梦     | 4    |
| 失败/重拍升级     | 只能原地重试**同模型**       | 一键升级即梦          | 5    |
| 全自动成片用即梦  | `auto.js` 硬编码 Agnes       | 角色图阶段用即梦      | 6    |

---

## 4. 成本模型（阶段 1 的前置设计）

### 4.1 单价表

新增于 `core/constants.js`，每项标注数据来源：

```js
/**
 * 即梦积分单价表。
 * source: 'measured' = 实测标定（可信）；'estimated' = 推断（UI 需提示"实际以扣费为准"）
 */
const DREAMINA_CREDIT_COST = {
  video: {
    // 实测：seedance2.0fast @ 720p / 5s = 25 积分
    '720p': { per_second: 5, source: 'measured' },
    '480p': { per_second: 3, source: 'estimated' },
    '1080p': { per_second: 15, source: 'estimated' },
    '4k': { per_second: 40, source: 'estimated' },
  },
  image: {
    // 实测：jimeng-image-3.1 @ 1k = 1 积分（返回 4 张候选，计费按「次」而非「张」）
    'jimeng-image-3.1': { per_request: { '1k': 1, '2k': 2 }, source: 'measured' },
    'jimeng-image-5.0': { per_request: { '2k': 3, '4k': 6 }, source: 'estimated' },
    'jimeng-image-5.0pro': { per_request: { '1.5k': 4, '2k': 6, '4k': 10 }, source: 'estimated' },
  },
};
```

> **待补实测**：图片 5.0 / 5.0pro 的真实单价、视频各分辨率的真实单价。
> 建议在阶段 1 完成后，用最低规格各跑一次真实任务，把 `estimated` 升级为 `measured`。

### 4.2 预估函数

新增于 `services/payloads.js`（纯函数，可单测）：

```js
/**
 * 预估即梦任务消耗的积分
 * @returns {{points:number, confidence:'measured'|'estimated', breakdown:string}}
 */
function estimateDreaminaCost(model, params) { ... }
```

- 视频：`per_second × duration`（分辨率取模型允许档位）
- 图片：`per_request[resolution]`（**与 `count` 无关**——实测 1 次请求即返回 4 张，计费按次）
- 任一环节只有 `estimated` 数据 → 整体 `confidence = 'estimated'`

### 4.3 阈值与确认策略

| 常量/设置                    | 默认值 | 位置                                         |
| ---------------------------- | ------ | -------------------------------------------- |
| `dreamina_confirm_threshold` | `10`   | `db/repos/settings.js` 的 `DEFAULT_SETTINGS` |
| `DREAMINA_DEFAULT_THRESHOLD` | `10`   | `core/constants.js`（兜底）                  |

判定逻辑（后端提供，前端消费）：

```js
// services/payloads.js 或新模块
function checkDreaminaGuard(model, params, { threshold, remainingCredit }) {
  const est = estimateDreaminaCost(model, params);
  if (est.points > remainingCredit) return { level: 'block', ...est };
  if (est.points > threshold) return { level: 'confirm', ...est };
  return { level: 'pass', ...est };
}
```

---

## 5. 分阶段实施

### 阶段 1：后端即梦管理 API

**目标**：让前端能查询即梦状态、完成登录、获取成本预估。

#### 1.1 新增路由文件 `routes/dreamina.js`

注册进 `server.js`（在现有 11 个路由之后**追加**，见 `server.js:36-46`）。

| 方法   | 路径                        | 说明                                    |
| ------ | --------------------------- | --------------------------------------- |
| `GET`  | `/api/dreamina/status`      | 安装状态 / 登录态 / 剩余积分 / VIP 等级 |
| `POST` | `/api/dreamina/login`       | 发起无头登录，返回授权材料              |
| `POST` | `/api/dreamina/login/check` | 携 `device_code` 完成登录               |
| `POST` | `/api/dreamina/logout`      | 清除本地登录态                          |
| `GET`  | `/api/dreamina/cost`        | 成本预估（query: `model` + 参数）       |

**`GET /api/dreamina/status` 响应契约**：

```json
{
  "installed": true,
  "bin": "C:\\Users\\...\\dreamina.exe",
  "logged_in": true,
  "user_id": "991111216374787",
  "vip_level": "standard",
  "total_credit": 734,
  "cached_at": 1789553000000,
  "expires_at": null
}
```

未安装 / 未登录时**不报错**，返回 `{ installed: false }` 或 `{ installed: true, logged_in: false }`。

#### 1.2 缓存与降级（关键）

`dreamina credit()` 需要 spawn CLI（实测约 1s），**不能每次请求都调**：

- 内存缓存 **60 秒**（进程级，`Map` 或单变量）
- 支持 `?refresh=1` 强制刷新
- spawn 超时 / 失败时返回**上次缓存值 + `stale: true`**，绝不 500

#### 1.3 改动清单

| 文件                         | 改动                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `routes/dreamina.js`         | 新建（5 个端点）                                          |
| `server.js:36-46`            | 追加 require + 注册                                       |
| `core/openapi.js:10-162`     | 手工追加 5 条路径摘要（**必须手动**，非自动收集）         |
| `core/constants.js`          | 新增 `DREAMINA_CREDIT_COST`、`DREAMINA_DEFAULT_THRESHOLD` |
| `db/repos/settings.js:20-37` | `DEFAULT_SETTINGS` 新增 `dreamina_confirm_threshold`      |
| `routes/settings.js`         | GET/PUT 支持该设置项                                      |
| `services/payloads.js`       | 新增 `estimateDreaminaCost` / `checkDreaminaGuard`        |

#### 1.4 验收

- [ ] 未安装 CLI 时 5 个端点均返回结构化结果（不 500）
- [ ] `status` 连续调用 3 次，第 2、3 次不 spawn（命中缓存）
- [ ] `estimateDreaminaCost` 单测：视频/图片/未知模型各一例
- [ ] e2e 冒烟：至少覆盖 `status` 与 `cost`
- [ ] `npm test` 全绿

---

### 阶段 2：前端设置页即梦面板

**目标**：在控制台内完成即梦的查看与登录。

#### 2.1 界面

设置弹窗（`public/index.html:343` 附近）新增「即梦 CLI」区块：

- 状态行：已安装/未安装 · 已登录/未登录 · **剩余积分** · VIP 等级
- 未安装：显示安装命令 `curl -fsSL https://jimeng.jianying.com/cli | bash`
- 未登录：显示「登录」按钮
- 成本护栏：阈值输入框（`dreamina_confirm_threshold`）

#### 2.2 登录交互（OAuth Device Flow）

```
点击「登录」
  → POST /api/dreamina/login
  → 展示 verification_uri + user_code（可复制）
  → 按 poll_interval（约 1s）轮询 POST /api/dreamina/login/check { device_code }
  → 成功后刷新状态；授权码 10 分钟过期则提示重新发起
```

⚠️ **官方文档明确**：不要通过 Agent 启动 CLI 完成登录（Agent 环境下 `dreamina login` 打印的 URL 有误）。本面板调用的正是 CLI，若遇「非法应用」错误，需引导用户先手动登录即梦 Web 端再重试。

#### 2.3 改动清单

| 文件                         | 改动                           |
| ---------------------------- | ------------------------------ |
| `public/index.html:343` 附近 | 新增即梦区块 DOM               |
| `public/settings-panel.js`   | 状态拉取、登录轮询、阈值保存   |
| `public/styles/base.css`     | 区块样式（设置弹窗属全站基础） |

#### 2.4 验收

- [ ] 未安装状态下面板显示安装指引，不报错
- [ ] 登录全流程可完成（含授权码过期提示）
- [ ] 阈值修改后立即生效（无需重启）

---

### 阶段 3：前端模型选择 + 成本护栏

**目标**：让使用者在提交前看到并控制成本。

#### 3.1 `/api/meta` 扩展

**新增独立字段**（不混入现有 `models`，避免破坏既有下拉契约）：

```json
{
  "models": [ ...不变... ],
  "dreamina": {
    "available": true,
    "video": [{ "id": "seedance2.0fast", "label": "...", "resolutions": ["720p"], "minDuration": 4, "maxDuration": 15 }],
    "image": [{ "id": "jimeng-image-3.1", "label": "...", "resolutions": ["1k", "2k"] }]
  }
}
```

`available` 由 CLI 状态决定（未就绪则前端不显示即梦分组）。

#### 3.2 下拉分组渲染

`public/task-meta.js:35-37` 的 `#fModel` 改为 `<optgroup>` 分组：

```html
<optgroup label="Agnes（免费）">
  <option value="agnes-video-2.5-flash">...</option>
</optgroup>
<optgroup label="即梦（收费 · 积分）">
  <option value="seedance2.0fast">...</option>
</optgroup>
```

图片表单（`new-task.js:29-36` 的 `collectImageBody`）同样支持即梦图片模型。

#### 3.3 成本护栏前端接入

提交即梦任务前调用 `GET /api/dreamina/cost`：

| 返回 level | 前端行为                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| `pass`     | 直接提交                                                                               |
| `confirm`  | 弹窗「预估 N 积分 · 剩余 M 积分 · 确认生成？」（`estimated` 时追加「实际以扣费为准」） |
| `block`    | 禁止提交，提示改用免费模型或充值                                                       |

#### 3.4 改动清单

| 文件                                     | 改动                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| `routes/meta.js:21-40`                   | 响应新增 `dreamina` 字段                              |
| `public/task-meta.js`                    | 分组渲染、即梦参数联动（分辨率/时长白名单随模型变化） |
| `public/new-task.js:29-36,130`           | 图片/视频表单支持即梦模型 + 护栏调用                  |
| `public/workspace.js` / `ws-video.js:19` | 工作台镜头提交支持带 `model`（当前 `body: {}`）       |
| `public/styles/*.css`                    | `optgroup` 与确认弹窗样式                             |

#### 3.5 验收

- [ ] 未安装即梦时下拉不出现即梦分组（零回归）
- [ ] 选即梦图片（1 积分）→ 静默通过，无弹窗
- [ ] 选即梦视频 15s（75 积分）→ 弹窗确认
- [ ] 剩余积分不足时强阻断
- [ ] 现有 Agnes 提交流程完全不受影响

---

### 阶段 4：角色图异步化 + 即梦默认

**目标**：角色图默认用即梦（1 积分/4 张），并解决同步接口不支持即梦的问题。

#### 4.1 问题

当前角色图走 **同步** `POST /api/images/generate`（`public/ws-char.js:61-93`），该接口对即梦模型直接返回 400（`routes/images.js:62-65`）。而即梦图片是**异步任务**。

#### 4.2 改造

| 改动                                       | 说明                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `ws-char.js` 改调 `POST /api/images/tasks` | 异步入队，返回任务记录                                                                              |
| 新增等待/刷新机制                          | 入队后显示「生成中」，通过 `bus` 订阅 `tasks-changed`（`task-center.js:12` 已有先例）或轮询任务状态 |
| 默认模型                                   | `jimeng-image-3.1`（1 积分）；可切回 Agnes                                                          |
| 阈值校验                                   | 1 积分 ≤ 10，**静默通过**（符合"额度少的默认通过"）                                                 |

#### 4.3 风险

**这是本计划唯一改变既有交互的改动**：从「点一下等 30–180s 出图」变为「入队 → 后台生成 → 自动刷新」。

- 若即梦未就绪：**自动回退 Agnes 同步接口**（保持现有体验）
- 需要明确「生成中」的视觉反馈，避免用户以为没反应

#### 4.4 验收

- [ ] 即梦就绪时角色图走异步，1 积分得 4 张候选
- [ ] 即梦未就绪时自动回退同步 Agnes，行为与改造前一致
- [ ] 生成中状态可见，完成后自动刷新图片墙

---

### 阶段 5：失败/重拍提示升级

**目标**：免费模型反复失败时，提示一键升级到即梦（**不自动扣费**）。

#### 5.1 触发条件

- `retry_count >= 3`（可配）
- **且** 当前任务模型为 Agnes（`providerOf(model) === 'agnes'`）
- 位置：`public/task-center.js` 的卡片（`:151-153`）、时间线行（`:229-231`）、详情弹窗（`:682-683`）

#### 5.2 后端支持

新增 `POST /api/tasks/:id/upgrade`，请求体 `{ model }`：

- 校验：仅 `failed` / `submit_error` 可升级
- 目标模型必须是**另一个 provider**（防止无意义调用）
- ⚠️ 现有 `retryTask` SQL（`db/sql.js:89-98`）**不更新 `model`**，需扩展该语句或新增 `upgradeTask` 语句
- 复用 `tasks.retry()` 的原地语义（任务 ID 不变，`retry_count` 自增）

#### 5.3 前端提示

```
任务卡片（失败 · 已重试 3 次）
  [重试]  [↑ 升级即梦（约 25 积分）]
```

点击后先过成本护栏（阶段 3 的 `checkDreaminaGuard`），再调 `/upgrade`。

#### 5.4 验收

- [ ] Agnes 任务失败 3 次后出现升级按钮
- [ ] 升级后任务 ID 不变、`model` 已切换、`retry_count` 递增
- [ ] 即梦任务失败时不显示升级按钮（已是收费档）
- [ ] 升级前必经成本确认弹窗

---

### 阶段 6：全自动成片的角色图用即梦

**目标**：`workers/auto.js` 的 `character` 阶段改用即梦（1 积分/项目，成本可忽略）。

#### 6.1 现状

`workers/auto.js:396-413` 的 `doCharacter` **硬编码** `IMAGE_MODEL`（`agnes-image-2.5-flash`），`auto.js` 内**无 `providerOf()` 调用**。

#### 6.2 改造

| 改动              | 说明                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `auto.js:396-413` | 模型由设置项决定（`dreamina_auto_character`，默认开）                    |
| 降级              | 即梦未就绪（未装/未登录/积分不足）时**自动回退 Agnes**，不中断全自动流程 |
| 成本护栏          | 1 积分 ≤ 阈值 → 静默通过（无需确认，因是全自动流程）                     |
| `AGENTS.md`       | 补充该调度决策                                                           |

#### 6.3 验收

- [ ] 即梦就绪时全自动成片的角色图用即梦
- [ ] 即梦未就绪时无缝回退 Agnes，全流程不中断
- [ ] e2e 全自动成片闭环仍全绿

---

## 6. 数据与配置变更

### 6.1 新增设置项

| 键                           | 默认   | 说明                         |
| ---------------------------- | ------ | ---------------------------- |
| `dreamina_confirm_threshold` | `'10'` | 成本确认阈值（积分）         |
| `dreamina_auto_character`    | `'1'`  | 全自动成片的角色图是否用即梦 |

均加入 `db/repos/settings.js` 的 `DEFAULT_SETTINGS`，并在 `routes/settings.js` 的 GET/PUT 中支持。

### 6.2 数据库

**无 schema 变更**（继续复用 `tasks.video_id` 承载 `submit_id`）。

### 6.3 新增路由（5 条）

见阶段 1。均需同步 `core/openapi.js` 手写清单（当前 60 条路径）。

---

## 7. 测试策略

| 层级     | 覆盖                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 单元测试 | `estimateDreaminaCost` / `checkDreaminaGuard` 的边界（阈值、余额不足、图片按次计费）；`upgradeTask` 的 SQL 守卫 |
| e2e 冒烟 | 5 条新端点在**未安装 CLI** 环境下的结构化返回（graceful 是硬要求）                                              |
| 手工冒烟 | 前端下拉分组、成本弹窗三档、登录流程、角色图异步等待                                                            |
| 真实任务 | 各最低规格跑一次，把单价表的 `estimated` 升级为 `measured`                                                      |

**每阶段完成即跑**（规范第五条）：`npx prettier --check .` · `npm run lint` · `npm run test:unit` · `npm run test:mock` · `npm run build`

---

## 8. 风险与回滚

| 风险                          | 影响         | 缓解                                                       |
| ----------------------------- | ------------ | ---------------------------------------------------------- |
| 即梦队列极慢（实测 >50 分钟） | 视频体验差   | 文档明示；护栏提示等待时间；优先用图片                     |
| standard 会员优先级低         | 排队更久     | 卡片显示队列位置（`queue_info` 已在响应中）                |
| 单价表推断值不准              | 预估偏差     | 标注 `estimated` + UI 提示「实际以扣费为准」；逐步实测修正 |
| 角色图异步化改变交互          | 用户不习惯   | 即梦未就绪自动回退同步；「生成中」状态明确                 |
| CLI 版本升级导致字段漂移      | 产物解析失败 | 提取器多层兜底 + 失败时保留 `last_poll_response` 便于定位  |
| 新增 5 条路由影响契约         | e2e 需同步   | 每阶段补 e2e；openapi 手工同步                             |

**回滚**：所有即梦能力均可通过「未安装 CLI」自然降级（前端隐藏入口、任务保留 queued），无需回滚代码。

---

## 9. 明确不做

- ❌ `session` 会话管理、`image_upscale`（超清）、数字人
- ❌ provider 热切换（坚持「model 决定 provider」的零 schema 设计）
- ❌ 把即梦设为默认模型（保持 Agnes 为默认，符合成本均衡）
- ❌ 改动 `data/` 结构或 `tasks` 表 schema
- ❌ 自动扣费（除阶段 6 的 1 积分角色图外，一律需用户确认）

---

## 10. 决策记录

| #   | 决策                   | 选择                                    | 理由                               |
| --- | ---------------------- | --------------------------------------- | ---------------------------------- |
| 1   | 默认分工               | 图走即梦、视频走 Agnes                  | 735 积分 ≈ 2940 张图 vs 29 条视频  |
| 2   | 自动升级触发器         | 失败/重拍 N 次后**提示**，不自动升级    | 避免在用户不知情时扣费             |
| 3   | 角色图同步→异步        | 接受改造，未就绪时自动回退              | 即梦图片是异步任务，无法走同步接口 |
| 4   | 升级端点语义           | 原地改 model 重试（ID 不变）            | 与现有 `retry` 一致，保留溯源      |
| 5   | auto 是否用即梦        | 仅角色图阶段（1 积分/项目）             | 成本可忽略且角色图是全片根基       |
| 6   | 即梦是否进 `/api/meta` | 独立字段 `dreamina`，不混入 `models`    | 保护既有前端下拉契约               |
| 7   | **成本护栏**           | 三档阈值（静默/确认/阻断），默认阈值 10 | 少量额度不打扰，大额必须确认       |
