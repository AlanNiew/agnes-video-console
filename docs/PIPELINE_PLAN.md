# AI 视频创作流水线 —— 开发实施方案（v2）

> 目标：把现有的「视频任务控制台」升级为一套完整的 AI 视频创作流水线：
> **创意 → 文案/提示词（文本模型） → 角色设定图（图片模型） → 视频生成（视频模型，引用角色图减少幻觉）**

## 0. 模型策略（本版聚焦最新免费三件套）

| 步骤 | 模型 | 端点 | 调用方式 | 价格 |
| --- | --- | --- | --- | --- |
| 提示词优化/文案 | `agnes-2.5-flash` | `POST /v1/chat/completions` | 同步（秒级） | 免费 |
| 角色/场景图 | `agnes-image-2.1-flash` | `POST /v1/images/generations` | 同步（数秒~几十秒） | 免费 |
| 视频生成 | `agnes-video-2.5-flash` | `POST /v1/videos` + `GET /agnesapi` | 异步轮询（复用现有 poller） | 免费 |

⚠️ 版本判定：`agnes-video-v2.0` 是**旧模型**，本版默认不提供（界面收敛，标记为旧模型），统一使用
**`agnes-video-2.5-flash`（最新免费视频模型）**。2.5-flash 支持 `text / keyframe / reference` 三种模式，
其中 **reference 模式（`images` 最多 5 张 + `<Picture N>` 占位符 + 可选 `audios`）正是"角色/场景参考"
的官方设计**，比 v2.0 的单图 `image` 字段更契合流水线，且轮询/URL 兼容性已在现有控制台验证过。

原则（按用户要求）：
- **只用最新模型**，旧模型（agnes-video-v2.0、agnes-2.0、image-2.0、video-2.5 付费版）本版不接入；
- **付费模型**（agnes-video-2.5）本版不重点做，界面上收敛隐藏，下一版统一模型注册表再开放；
- 解决「模型切换麻烦」：流水线模式下模型**自动确定**（视频默认 2.5-flash），用户不再手动挑模型。

## 1. 产品形态：工作台 + 任务中心

现有看板保留，更名为「**任务中心**」（视频任务的执行与监控）；新增「**创作工作台**」负责创意生产，两者通过 `project_id` 关联。

### 创作工作台 —— 项目制四步流水线

```
┌─────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1 创意   │ → │ 2 文案与提示词 │ → │ 3 角色设定图   │ → │ 4 视频生成    │
│ 一句话想法│   │ 文本模型生成： │   │ 图片模型生成： │   │ 视频模型：    │
│ 风格/时长 │   │ ·故事梗概     │   │ ·角色立绘 N 张 │   │ 角色图+分镜词 │
│ 画幅偏好  │   │ ·视频提示词   │   │ ·可重roll     │   │ → 提交任务队列│
│          │   │ ·角色描述     │   │ ·选定定稿     │   │ （任务中心跟踪）│
└─────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

每一步产物**可编辑、可重新生成、可选用**，全部落库可回溯。

### 轻量入口（任务中心保留）
新建视频表单加「✨ AI 优化提示词」按钮：调文本模型把手写描述优化成结构化视频提示词后回填表单——不建项目也能享受文本能力。

## 2. 关键技术决策

### 2.1 图片 URL 的公开可访问问题（核心难点）
视频 `image` / `keyframes` 模式要求素材 URL **可被 Agnes 服务公开访问**。本地图存本地后外网不可达。
**决策**：图片生成使用 `extra_body.response_format: "url"`，产出 Agnes 自家 CDN 地址（`storage.googleapis.com/agnes-aigc/...`）——它天然公开可访问，直接作为视频参考图传入；同时后端下载一份到本地 `data/artifacts/` 做永久预览备份（Agnes CDN URL 可能过期）。

### 2.2 角色一致性的实现路径
- 角色立绘 → 视频用 **2.5-flash 的 `reference` 模式**：`images: [定稿角色图URL]` + `<Picture 1>` 占位符，并可在提示词中同时引用 `audios`（音画参考）；
- 多角色/多场景 → 用 reference 多图（最多 5 张，多图合成后再入视频）或 **`keyframe` 首尾帧模式**（M2：两张定稿图做首尾帧过渡）；
- 提示词由文本模型按官方推荐结构生成（主体→动作→镜头→风格→声音），并在其中显式写明「保持角色外观与 `<Picture 1>` 一致」，降低幻觉。

### 2.3 同步与异步的分界
- 文本、图片是**同步接口**：请求即等待（图片超时设 180s，官方建议 60–360s），前端 loading 等待即可，无需轮询；
- 视频仍是**异步任务**：完全复用现有 submit/poller/看板体系。

### 2.4 图片生成是快照不是任务？
图片同步返回，但仍**落库为记录**（含 prompt、模型、url、本地路径、selected 标记），便于重 roll、比较与追溯；不进任务看板（避免同步任务混入异步队列）。

## 3. 数据模型（SQLite 迁移新增）

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  idea TEXT,                -- 一句话创意
  style TEXT,               -- 风格偏好
  aspect_ratio TEXT,        -- 画幅偏好
  seconds TEXT,             -- 目标时长
  status TEXT DEFAULT 'draft',  -- draft|copy_done|character_done|video_submitted
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE project_texts (   -- 文本生成记录（可多条版本）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT,                -- script|video_prompt|character_desc|scene_desc
  content TEXT,
  model TEXT,
  selected INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE project_images (  -- 图片生成记录
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT,                -- character|scene
  prompt TEXT,
  remote_url TEXT,          -- Agnes CDN（用于视频引用）
  local_path TEXT,          -- 本地备份（用于预览）
  size TEXT, ratio TEXT,
  model TEXT,
  selected INTEGER DEFAULT 0,   -- 定稿标记
  created_at INTEGER
);

ALTER TABLE tasks ADD COLUMN project_id INTEGER;  -- 视频任务关联项目
```

## 4. 后端 API（新增）

```
POST /api/llm/complete          通用文本生成（内置提示词模板：创意→结构化文案JSON）
POST /api/images/generate       图片生成（文生图/图生图，同步，落库）
GET  /api/images/:id            图片详情
GET  /artifacts/*               本地图片静态服务（data/artifacts）

POST /api/projects              创建项目
GET  /api/projects              项目列表
GET  /api/projects/:id          项目详情（聚合文案/图片/视频任务）
PATCH /api/projects/:id         更新（含步骤产物 selected 切换）
DELETE /api/projects/:id        删除项目（级联清理）

POST /api/projects/:id/videos   从项目发起视频任务：
                                自动组装 2.5-flash reference 请求：
                                {model: agnes-video-2.5-flash, prompt: 选定提示词(含<Picture 1>),
                                 mode: reference, images: [角色定稿图URL], seconds, size: 720P,
                                 aspect_ratio} → 复用 submitTask 入队
```

提示词模板（内置，可调）：系统提示要求模型**只输出 JSON**：
`{ "script": 梗概, "video_prompt": 视频提示词, "character_desc": 角色外观描述, "scene_desc": 场景描述 }`，便于前端结构化展示与逐项重生成。

## 5. 前端（改动）

1. 顶部导航：「创作工作台」｜「任务中心」（现有看板整体迁入）；
2. 工作台：项目列表 + 项目详情四步流程 UI（分步卡片、生成 loading、重roll、选用 ✓）；
3. 角色图墙：多图并排，单选定稿；场景图同理；
4. 第 4 步：展示「引用关系」（选定角色图缩略图 + 分镜提示词 + 时长/画幅参数）→「提交视频任务」→ 成功后链接跳转任务中心对应卡片；
5. 任务中心新建表单：加「✨ AI 优化提示词」按钮；模型选择收敛（默认 `agnes-video-2.5-flash`，付费 2.5 移入「高级」折叠，**v2.0 标记为旧模型并下架**）。

## 6. 里程碑

### M1（本阶段）—— 流水线 MVP
1. `agnes.js` 扩展：`chatComplete()`、`generateImage()`；
2. DB 迁移三张新表 + tasks.project_id；
3. 后端 API 全套（llm/images/projects/artifacts）；
4. 提示词优化模板 + JSON 解析容错（模型输出非 JSON 时降级为纯文本展示）；
5. 前端工作台四步 UI + 任务中心「AI 优化」按钮；
6. mock e2e 扩展：模拟 `/v1/chat/completions`、`/v1/images/generations`，全链路「创意→文案→角色图→视频任务」用例。

### M2（下一阶段）
- 分镜脚本结构化（多镜头 storyboard，一个项目批量出多条视频）；
- 图片本地归档打包导出、项目复制；
- 统一模型注册表（新旧模型一致化，按需开放付费模型）；
- 音频参考/音画同步接入（视 Agnes 能力）；
- 项目模板库（风格预设、角色库复用）。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 图片同步接口慢（几十秒） | 前端明确 loading 态 + 180s 超时 + 失败可重试 |
| Agnes CDN 图片 URL 过期 | 本地 artifacts 备份；视频引用用 CDN URL（生成时即时使用，一般不过期） |
| 文本模型输出不合规 JSON | system 强约束 + 解析失败降级为纯文本，前端仍可手动取用 |
| 免费配额 RPM（文本 20/分、视频 1/分） | 图片/文本调用做前端节流提示；视频本就串行轮询 |
| 角色一致性有限（reference 仍可能漂移） | 提示词显式约束 + 角色图构图简单正面 + M2 引入 keyframe 首尾帧/多图增强 |

## 8. 不做（本版明确排除）

- 付费模型（agnes-video-2.5 / 960P / 2K）深度接入；
- 旧模型（agnes-video-v2.0、agnes-2.0、image-2.0）兼容层与界面入口；
- 本地图片公开外发（内网穿透等）方案。
