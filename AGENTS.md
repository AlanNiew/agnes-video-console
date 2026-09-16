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
npm run build         # vite 构建前端 → dist/（M4-B0；dist 已 gitignore）
npm start             # http://127.0.0.1:8273（仅回环，勿改对外监听）
```

CI 顺序 = `lint → format:check → test:unit → test:mock`。改代码后的最小验证：`npm test`。

## 硬性要求

- **Node ≥ 22.13**（`node:sqlite`，API Key 存 SQLite，零原生编译）。
- **e2e 需要本机装 ffmpeg + ffprobe 且在 PATH**：渲染用例跑真实 ffmpeg 合成（含响度补偿与封面）；ffprobe 用于 TTS 时长探测，缺失时该用例静默跳过。
- **即梦为可选上游**：需本机装官方 `dreamina` CLI 并完成登录（`curl -fsSL https://jimeng.jianying.com/cli | bash`，Windows 落到 `~/bin/dreamina.exe`，可用 `DREAMINA_CLI_PATH` 覆盖）。缺失时即梦任务保留 queued 走 5 分钟退避（`not-installed` / `not-logged-in` / `need-web-confirm`），**Agnes 主链路不受任何影响**。登录为 OAuth Device Flow（`login --headless` + `login checklogin --device_code=…`），授权码有效期约 10 分钟。
- **即梦两条运维约束（官方《即梦 CLI 体验指南》）**：① **合规**——视频生成须先在即梦 Web 端用该模型完成一次生成，否则 CLI 返回 `AigcComplianceConfirmationRequired`（本系统归类为 `need-web-confirm`：保留入队等人工处理，**绝不判死**）；② **登录**——官方明确「不要通过 Agent 完成登录」（Agent 启动 CLI 时 `dreamina login` 打印的授权 URL 有误），应先在浏览器登录即梦 Web 端，再手动执行 `dreamina login` 并点授权。
- **db.js import 即副作用**：require 时就 mkdir 数据目录并打开 SQLite。任何单测须先设 `DATA_DIR`/`DB_PATH` 指向临时目录（见 `test/unit/setup.js`，jest `setupFiles` 已处理，勿改为 `setupFilesAfterEach`）。
- 429 退避单测加速：设 `SUBMIT_RATE_LIMIT_BASE_MS`（e2e 用 500 代替默认 60s）。

## 架构分层（新增代码放对地方）

```
server.js     装配层：require 路由 + 错误中间件 + 启动编排（5 个后台 worker）。不写业务。
core/         零/低依赖基元：constants（模型清单/白名单/上限/TTS/转场字幕预设 + providerOf 多上游推导，勿 require 其他模块）
              · config（跨模块单源常量）· errors（ApiError/ah，勿再造裸 Error+expose）
              · logger（内存环形日志）· openapi（API 自描述，读 package.json）
clients/      上游客户端：agnes（视频/chat/图片 API）· fish-tts（TTS，CONNECT 隧道）· netmusic（BGM）
              · dreamina（即梦官方 CLI 子进程；视频/图片均为异步任务，扣会员积分，spawn 必须防 stdin 阻塞）
services/     业务层：payloads（上游请求体校验/组装，不接触提交器）· task-queue（任务入队，
              建 queued 记录并唤醒 submitter）· prompts（提示词/LLM 输出解析）
              · subtitles（ASS/SRT 字幕纯函数）· voice-pool；pipeline 为依赖注入编排
lib/          本地文件/产物支撑：artifacts（素材备份 + works 作品目录定位）· publish-kit（发布文案）· render-stage（渲染阶段文案）
db/           数据层（require('./db') 由目录解析指向 db/index.js 组合出口，导出契约不变）：
              ├ kernel.js   连接/PRAGMA/schema DDL/自动迁移/parseJson/tx —— import 即副作用，
              │             （require 即开库），单测前先设 DATA_DIR/DB_PATH
              ├ sql.js      prepare 语句注册表（全部 SQL 单一审查点，repos 从这里取）
              └ repos/      settings / tasks / projects / renders 表族仓库（projects 含
                            texts/images/shots/tts 子域 CRUD 与级联删除，契约 projects.* 不变）
instance-lock.js  单实例工作锁（M3 自 db.js 拆出；settings 键原子 CAS），server/各 worker 经此判断锁
workers/      后台进程（均受单实例工作锁约束）：submitter（视频提交节流）/ poller（轮询归档）
              / image-worker（图片任务）/ render（成片渲染，ffmpeg 必须经其 runFfmpeg）
              / auto（全自动成片状态机，状态落 projects.auto_state）
              / manager —— 统一启停全部 worker；routes 驱动后台（轮询间隔重载/重试唤醒/手动轮询）
                一律经 manager，不得直接 require worker 实例做生命周期操作
routes/       11 个领域文件（含 templates 创作模板、characters 角色库），注册顺序必须与 server.js 装配顺序一致（保持现有顺序追加）
```

- 74 条 API 路由（路径 × 方法）的路径/状态码/响应结构是公开契约（`/api/openapi.json` 自描述 + e2e 全覆盖），重构时零容忍变更。
- 上游 API 校验逻辑集中在 `services/payloads.js`（buildV25Payload / buildV2Payload / buildImagePayload / buildDreaminaPayload / buildDreaminaImagePayload）。
- **多上游 provider 分发（零 schema 变更）**：模型 → 上游由 `core/constants.js` 的 `providerOf(model)` 推导（查 `DREAMINA_MODELS` / `DREAMINA_IMAGE_MODELS`，未命中即 Agnes）。submitter / poller / task-queue / image-worker / routes 均据此分流。即梦 `submit_id` 复用 `tasks.video_id` 列承载（poller 的 `active()` 靠它判定「已提交」，故 `activeTasks` 已加 `kind` 过滤，避免抢走即梦图片任务）。
- **调度策略（勿偏离）**：Agnes 免费档打主力（分镜视频全量走 `agnes-video-2.5-flash`），即梦只用于「量少但决定成败」的关键资产（角色图 / 封面；关键镜头可手动升级）。即梦模型**刻意不进** `/api/meta` 模型清单，故前端下拉不变，仅可经 API 直接指定调用。
- **ffmpeg 调用必须经 `workers/render.js` 的 `runFfmpeg`**（已内置 `-y -nostdin`）：缺失时输出同名文件已存在会触发 `Overwrite? [y/N]` 并永久阻塞等待 stdin（v2.0 踩过，渲染永久卡在 rendering）。
- 全自动成片编排在 `workers/auto.js`（状态机落 `projects.auto_state`）：阶段动作复刻对应路由的核心逻辑，新增阶段须同步 `STAGE_META` 与前端 `AUTO_STAGES`。

## 已知技术债（勿扩散，勿顺手大改）

- ~~`db.js` 的 `projects` 对象混装 6 个实体、superseded 业务规则写死在数据层~~ ✅ M3 已还：数据层目录化（`db/`），superseded 标注上移至 API 聚合层，单实例锁独立为根模块。残余：`db/repos/projects.js` 按表族合并了 project/texts/images/shots/tts 四子域（A 档决策），如需可再细拆。
- ~~`netmusic.js` 直读 db settings（客户端耦合数据层）~~ ✅ M4 已治理：改为依赖注入工厂 `createNetmusicClient(settings)`，装配方（routes/music、routes/settings、workers/auto、workers/render）接线，客户端不再 require db。
- ~~`workspace.js`（约 880 行）巨型 IIFE + 全量 innerHTML 重渲染~~ ✅ **M4 专项已全部交付（B0–B4）**：B0（vite）/ B1（互调清零）/ B2（任务中心按文件拆）/ B3-1~B3-7（渲染纯函数 `ws-render.js`、配音+声音广场 `ws-tts.js`、会话状态 `ws-state.js`、工具+视频提交 `ws-util.js`/`ws-video.js`、角色图 `ws-char.js`、文案分镜 `ws-story.js`、BGM 面板 `ws-bgm.js` + 渲染面板 `ws-render-panel.js`）/ B4（`style.css` 2341 行按视图拆为 `public/styles/` 六文件：base / task-center / new-task / workspace / works / theme-light，vite 构建合并单产物，层叠顺序校验 0 翻转、逐行搬运零行为变化）。workspace.js 现仅剩装配与步骤导航绑定。
- 单实例锁的**误接管窗口**（已知不修，收益<成本）：持有者进程存在 >15s 的事件循环同步阻塞（渲染 spawnSync/大文件写盘）会饿死 10s 心跳，锁过期被接管后原持有者在途 tick/renderJob 不复查锁 → 双 worker 并行数分钟（重复轮询/限流失效，产物文件带时间戳不冲突）。锁**获取**已是原子 CAS（v1.9.2，跨进程并发验证通过）；渲染中崩溃遗留任务由 start() 自愈复位。

## 前端约定

- 构建：`npm run build`（vite → `dist/`，已 gitignore）。服务端先服务 `dist/`、未构建时回退 `public/`
  （`public/main.js` 为原生 ESM 入口——顺序 import common→compare→app→workspace，现代浏览器可直接跑源码调试）。
- 前端已全面 ESM：`common`/`compare`/`state`/`task-meta` 为基础模块，`app.js` 为装配层（按序拉入
  `settings-panel`/`new-task`/`works-panel`/`task-center` 并编排主视图切换/轮询/初始化），
  `workspace.js` 内部仍为 IIFE 视图（渲染纯函数已拆至 `ws-render.js`，渲染面板/BGM 绑定已拆至 `ws-render-panel.js`/`ws-bgm.js`）——互相不再经 window 通信
  （**`window.__*` 代码引用已清零**，跨视图走 `state.js` bus）。
  样式按视图拆为 `public/styles/` 六文件（base / task-center / new-task / workspace / works / theme-light），
  **加载顺序敏感**：base 在前、theme-light 必须最后（浅色主题靠后加载覆盖深色变量）；`index.html` 按序引用，vite 构建合并为单产物。
  M4 专项（B0–B4）全部交付，详情见 `docs/FRONTEND_REFACTOR_PLAN.md`。
- 渲染/BGM 交互的**局部更新**纪律：渲染任务提交/轮询只增改 `#wsRenderJobs` 子树、BGM 选用/清除只改 `#wsBgmCurrent`/`#wsPrecheck`/步骤⑥圆点（`ws-bgm.js` 的 `refreshBgmArea`），不整页重绘——避免清空其它步骤未保存输入与面板已调配置。
- 插值进 innerHTML 的任何动态内容必须过 `esc()`。
- 前端无自动化测试——改动后需人工冒烟或跑 e2e 验证后端契约未破坏。

## 约定

- 全仓中文注释与中文提交信息；提交前缀 `feat:/fix:/refactor:/style:/test:/docs:`。
- **一个功能或阶段完成且验证通过（lint + 相关单测/e2e）后默认即可提交**，无需等用户逐次催提交；除非用户明确说先不提交。提交信息按前缀规则写清楚改动范围。
- 行长 ≤120（prettier 已强制）；文件统一 LF（Windows 上 git 的 CRLF 警告属正常）。
- 版本发布：`package.json` 版本号与 `CHANGELOG.md`（Keep a Changelog 格式）同次提交。
- `data/`（真实库 + 产物归档）已 gitignore，永不提交；e2e 会写 `data/e2e-test.db` 与 `data/e2e-artifacts`，同样不提交。
- **从 0 到 1 创作视频**（用本平台真实生成成片）前，先读 `docs/CREATION_PLAYBOOK.md`——实测 SOP、避坑清单（中文 JSON 勿走 PowerShell curl、旁白 ≤ 秒数×4 字等）、成片自检清单与标定数据。
