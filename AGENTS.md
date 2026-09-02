# AGENTS.md

本地 Web 工具：Agnes AI 视频生成任务控制台。Express + `node:sqlite`，CommonJS，**运行时依赖仅 express**（新库只进 devDependencies）。

## 常用命令

```bash
npm test              # = jest 单测 + e2e 冒烟（提交前必跑）
npm run test:unit     # 仅 74 项单测
npm run test:mock     # 仅 e2e（自建 mock 上游 :8392，应用拉起于 :8391，约 2–4min：含全自动成片闭环 + 3 次真实 ffmpeg 渲染）
npx jest test/unit/payloads.test.js   # 跑单个测试文件
npm run lint          # eslint（0 errors 才算过；10 个既有 warning 勿需修）
npm run format        # prettier 写入；format:check 用于 CI 校验
npm start             # http://127.0.0.1:8273（仅回环，勿改对外监听）
```

CI 顺序 = `lint → format:check → test:unit → test:mock`。改代码后的最小验证：`npm test`。

## 硬性要求

- **Node ≥ 22.13**（`node:sqlite`，API Key 存 SQLite，零原生编译）。
- **e2e 需要本机装 ffmpeg + ffprobe 且在 PATH**：渲染用例跑真实 ffmpeg 合成（含响度补偿与封面）；ffprobe 用于 TTS 时长探测，缺失时该用例静默跳过。
- **db.js import 即副作用**：require 时就 mkdir 数据目录并打开 SQLite。任何单测须先设 `DATA_DIR`/`DB_PATH` 指向临时目录（见 `test/unit/setup.js`，jest `setupFiles` 已处理，勿改为 `setupFilesAfterEach`）。
- 429 退避单测加速：设 `SUBMIT_RATE_LIMIT_BASE_MS`（e2e 用 500 代替默认 60s）。

## 架构分层（新增代码放对地方）

```
server.js     装配层：require 路由 + 错误中间件 + 启动编排（5 个后台 worker）。不写业务。
core/         零/低依赖基元：constants（模型清单/白名单/上限/TTS/转场字幕预设，勿 require 其他模块）
              · config（跨模块单源常量）· errors（ApiError/ah，勿再造裸 Error+expose）
              · logger（内存环形日志）· openapi（API 自描述，读 package.json）
clients/      上游客户端：agnes（视频/chat/图片 API）· fish-tts（TTS，CONNECT 隧道）· netmusic（BGM）
services/     业务层：payloads（上游请求体校验/组装，不接触提交器）· task-queue（任务入队，
              建 queued 记录并唤醒 submitter）· prompts（提示词/LLM 输出解析）
              · subtitles（ASS/SRT 字幕纯函数）· voice-pool；pipeline 为依赖注入编排
lib/          本地文件/产物支撑：artifacts（素材备份 + works 作品目录定位）· poster（社交海报）
db.js         数据层（SQLite：任务/项目/文案/图片/镜头/配音/渲染任务表 + 迁移 + 事务 + 实例锁）
              —— import 即副作用（require 即开库），单测前先设 DATA_DIR/DB_PATH
workers/      后台进程（均受单实例工作锁约束）：submitter（视频提交节流）/ poller（轮询归档）
              / image-worker（图片任务）/ render（成片渲染，ffmpeg 必须经其 runFfmpeg）
              / auto（全自动成片状态机，状态落 projects.auto_state）
              / manager —— 统一启停全部 worker；routes 驱动后台（轮询间隔重载/重试唤醒/手动轮询）
                一律经 manager，不得直接 require worker 实例做生命周期操作
routes/       9 个领域文件，注册顺序必须与 server.js 装配顺序一致（保持现有顺序追加）
```

- 59 条 API 路由的路径/状态码/响应结构是公开契约（`/api/openapi.json` 自描述 + e2e 全覆盖），重构时零容忍变更。
- 上游 API 校验逻辑集中在 `services/payloads.js`（buildV25Payload / buildV2Payload / buildImagePayload）。
- **ffmpeg 调用必须经 `workers/render.js` 的 `runFfmpeg`**（已内置 `-y -nostdin`）：缺失时输出同名文件已存在会触发 `Overwrite? [y/N]` 并永久阻塞等待 stdin（v2.0 踩过，渲染永久卡在 rendering）。
- 全自动成片编排在 `workers/auto.js`（状态机落 `projects.auto_state`）：阶段动作复刻对应路由的核心逻辑，新增阶段须同步 `STAGE_META` 与前端 `AUTO_STAGES`。

## 已知技术债（勿扩散，勿顺手大改）

- `db.js` 的 `projects` 对象混装 6 个实体、superseded 业务规则写死在数据层——拆分是既定后续工作，改动前先对齐方案。
- `netmusic.js` 直读 db settings（客户端耦合数据层），新客户端勿模仿。
- `workspace.js`（约 2200 行）全量 innerHTML 重渲染 + `window.__ws`/`window.__app` 全局互调——已知，未列入本次改造范围。
- 单实例锁的**误接管窗口**（已知不修，收益<成本）：持有者进程存在 >15s 的事件循环同步阻塞（渲染 spawnSync/大文件写盘）会饿死 10s 心跳，锁过期被接管后原持有者在途 tick/renderJob 不复查锁 → 双 worker 并行数分钟（重复轮询/限流失效，产物文件带时间戳不冲突）。锁**获取**已是原子 CAS（v1.9.2，跨进程并发验证通过）；渲染中崩溃遗留任务由 start() 自愈复位。

## 前端约定

- 无构建步骤：经典 `<script>` 顺序加载，`public/common.js` 必须最先加载（`window.__common` 提供 esc/api/fmtTime/toast/$）。
- 插值进 innerHTML 的任何动态内容必须过 `esc()`。
- 前端无自动化测试——改动后需人工冒烟或跑 e2e 验证后端契约未破坏。

## 约定

- 全仓中文注释与中文提交信息；提交前缀 `feat:/fix:/refactor:/style:/test:/docs:`。
- 行长 ≤120（prettier 已强制）；文件统一 LF（Windows 上 git 的 CRLF 警告属正常）。
- 版本发布：`package.json` 版本号与 `CHANGELOG.md`（Keep a Changelog 格式）同次提交。
- `data/`（真实库 + 产物归档）已 gitignore，永不提交；e2e 会写 `data/e2e-test.db` 与 `data/e2e-artifacts`，同样不提交。
- **从 0 到 1 创作视频**（用本平台真实生成成片）前，先读 `docs/CREATION_PLAYBOOK.md`——实测 SOP、避坑清单（中文 JSON 勿走 PowerShell curl、旁白 ≤ 秒数×4 字等）、成片自检清单与标定数据。
