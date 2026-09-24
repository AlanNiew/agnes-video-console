# AGENTS.md

本地 Web 工具：Agnes AI 视频生成任务控制台。Express + `node:sqlite`，CommonJS，**运行时依赖仅 express**（新库只进 devDependencies）。

## 常用命令

```bash
npm test              # = jest 单测 + e2e 冒烟（提交前必跑）
npm run test:unit     # 仅单测（jest，13 套件；不触网、不 spawn CLI、不扣积分）
npm run test:mock     # 仅 e2e（自建 mock 上游 :8392，应用拉起于 :8391，约 2–4min：含全自动成片闭环 + 3 次真实 ffmpeg 渲染）
npx jest test/unit/payloads.test.js   # 跑单个测试文件
npm run lint          # eslint（0 errors 才算过；11 个既有 warning 勿需修）
npm run format        # prettier 写入；format:check 用于 CI 校验
npm run build         # vite 构建前端 → dist/（M4-B0；dist 已 gitignore）
npm start             # http://127.0.0.1:8273（仅回环，勿改对外监听）
```

CI 顺序 = `lint → format:check → test:unit → test:mock`。改代码后的最小验证：`npm test`。

## 本机开发环境（Windows）

- **shell = PowerShell 7（`pwsh`），经 `~/bin/pwsh-utf8.exe` 包装**：opencode 全局配置 `"shell": "C:/Users/AlanNiew/bin/pwsh-utf8.exe"`。**勿回退 Windows PowerShell 5.1**——5.1 无 `&&`/`||`、无 `rg`，且中文经管道必乱码（历史事故：中文 JSON 走 PS5.1 乱码致删库重建）。pwsh 7 实测支持 `&&`、中文参数与含空格参数的原生传递。
- **为什么需要包装器**：opencode 以 `-NoProfile -NonInteractive -Command` 启动 shell，**会绕过 `$PROFILE`**（实测：profile 里设的 `HTTP_PROXY` 在会话中不可见）。包装器在 pwsh 启动前把控制台代码页切到 65001，并在 `-Command` 脚本文本前注入 `[Console]::OutputEncoding`/`$OutputEncoding` 的 UTF-8 设置——否则中文输出是 GBK 字节、opencode 按 UTF-8 解码必乱码。源码 `~/bin/pwsh-utf8.cs`（`csc /target:exe` 编译），可用 `PWSH_UTF8_TARGET` 覆盖真实 pwsh 路径。
- **npm 脚本的 shell 也指向包装器**：`npm config set script-shell "C:\Users\AlanNiew\bin\pwsh-utf8.exe"`（Windows 下 npm 默认用 cmd.exe 跑脚本，是除 opencode 之外的另一个 shell 入口）。实测 `&&` 脚本链、`npm run lint`、`jest` 全部正常；回退用 `npm config delete script-shell`。
- **Windows Terminal 默认 profile 已设为 PowerShell 7**（`{574e775e-4f2a-5b96-ac1e-a2962a402336}`），手动开终端即 PS7；其 UTF-8 基线来自 `$PROFILE`（`~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`）。本机默认代码页 **GBK(936)**，中文输出异常时先核对这两处。
- **`rg`（ripgrep 15）/ `fd` 已装且入 PATH**：检索用 `rg`、找文件用 `fd`；`grep`/`find` 在本机不存在。
- **跨 shell 传参一律「写脚本文件」**（`tools/` 既有约定，如 `tools/agnes-api.js`），不要依赖多级引号转义。
- **中文 JSON 勿走 `curl.exe`**：一律 Node fetch，详见 `docs/CREATION_PLAYBOOK.md` 第五节。
- CRLF：`.gitattributes`（`* text=auto eol=lf`）已闭环 + 全局 `core.autocrlf=input`，`format:check` 在 Windows 与 CI 结论一致。

## 硬性要求

- **Node ≥ 22.13**（`node:sqlite`，API Key 存 SQLite，零原生编译）。
- **e2e 需要本机装 ffmpeg + ffprobe 且在 PATH**：渲染用例跑真实 ffmpeg 合成（含响度补偿与封面）；ffprobe 用于 TTS 时长探测，缺失时该用例静默跳过。
- **即梦为可选上游**：需本机装官方 `dreamina` CLI 并完成登录（`curl -fsSL https://jimeng.jianying.com/cli | bash`，Windows 落到 `~/bin/dreamina.exe`，可用 `DREAMINA_CLI_PATH` 覆盖）。**v2.6.1 起默认自动回退**：`not-installed` / `not-logged-in` / `need-web-confirm` 等原因触发即改投 Agnes 免费档继续制作（设 `dreamina_fallback='0'` 才回到旧的「保留 queued 走 5 分钟退避」行为），**Agnes 主链路始终不受影响**。登录为 OAuth Device Flow（`login --headless` + `login checklogin --device_code=…`），授权码有效期约 10 分钟。
- **即梦两条运维约束（官方《即梦 CLI 体验指南》）**：① **合规**——视频生成须先在即梦 Web 端用该模型完成一次生成，否则 CLI 返回 `AigcComplianceConfirmationRequired`（本系统归类为 `need-web-confirm`；**v2.6.1 默认不等它**——直接改投免费档出片，人工解锁后再补拍）；② **登录**——官方明确「不要通过 Agent 完成登录」（Agent 启动 CLI 时 `dreamina login` 打印的授权 URL 有误），应先在浏览器登录即梦 Web 端，再手动执行 `dreamina login` 并点授权。
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
- **即梦实测标定（成本护栏依据）**：图片 `jimeng-image-3.1` / 1k = **1 积分**，且一次请求返回 **4 张候选**（即便传 `generate_num:1`）；视频 5s/720p = **25 积分**。**⚠️ 单价按模型不同**：实测 `seedance2.0` 720p = **8 积分/秒**（10s 实扣 80），而 `seedance2.0fast` = 5 积分/秒——故价目表用 `DREAMINA_CREDIT_COST.videoByModel` 做模型覆盖档，**勿再按分辨率取单一值**（曾因此低报 60%）。成功响应结构统一为 `result_json.images[].image_url` / `result_json.videos[].video_url`（提取器：`clients/dreamina.js` 的 `extractImageUrls` / `extractVideoUrls`，含多层兜底）。standard 会员 `priority:3` 偏低，实测视频排队超过 1 小时。
- **即梦视频实测结论（2026-09 初测 → 2026-09-24 复核，后者部分推翻前者）**：初测时**排队以「天」计且队列净增长**（43 小时仅前进 6210 位，`queue_length` 反从 540k 涨到 553k），**并发上限 = 1**（只要 1 个任务在排队，后续提交即报 `ExceedConcurrencyLimit`，**锁死整个账户的视频功能**）。对比同机实测：**Agnes 免费档视频 327–527 秒（5–9 分钟）稳定出片**，连续 12 个任务全部成功。
  → **视频主力必须用 Agnes**；即梦的价值在**图片**（实测 27–32 秒、1 积分/次）。官方宣传的「快」指**推理速度**（Mini 比 Fast 快 2 倍即此意），与**排队**是两个维度——**换任何模型（含 Mini）都不解决排队**（排队由账户 `priority` 决定）。
  → CLI **没有任何取消任务的命令**（`list_task`/`query_result` 只读，`session delete` 删的是会话容器），页面端也只能看排队、不能终止；卡死任务只能等自然结束或联系即梦客服。
  → ✅ **2026-09-24 更新（standard 会员实测，结论部分推翻）**：对 **`seedance2.0mini`** 而言"天级排队"**已不成立** —— 提交后 `dreamina query_result --submit_id=…` 显示 `queue_info: {queue_idx: 0, priority: 3, queue_status: "Generating", queue_length: 0}`，**150 秒即出片**（5s / 720p / 实扣 30 积分），且**未触发合规闸门**。因此即梦视频可作为**队列空闲时的备用通道**（本次正是用它补上了 Agnes flash 连续 503 补不齐的镜头）。⚠ 但两条约束仍在：① **并发上限 1** —— 提交前先用 `query_result`/`list_task` **只读**看 `queue_length`，别盲目占坑；② 旧数据里的天级排队可能随账户 `priority` 或平台负载复现，故"能不能用"要**当场只读查**，不要凭历史结论。
- **即梦模型清单以 CLI help 的「公开支持集」为准**（`dreamina <子命令> -h`）：图片 text2image 共 9 档（3.0/3.1/4.0/4.1/4.5/4.6/4.7/5.0/5.0Pro），视频**因各子命令支持集不同**故用 `specs` 按子命令声明（text2video 6 个；image2video 8 个，多出 `seedance1.0fast` / `seedance1.5pro` 两个仅图生的老代际）。后端白名单更宽（实测含 `3.0_fast`/`3.5pro`/`seedance1.0` 等未公开项），但官方明确「listed model values are the CLI's public support set」，故**不采用未公开项**。
- **Seedance 2.5「样片模式」= 2.5 @ 480p，不是独立模型**（2026-09-23 核对 CLI v ec1b9fa）：网页端原文「先生成 480P 样片，确认满意后可升级为高清正片」，而 CLI 侧**没有** `sample`/`draft` 旗标，`seedance2.5` 的 `--video_resolution` 本就支持 `480p`。所以本系统里选「即梦 → `seedance2.5` → 480p」即等价于样片模式（前端下拉靠 `label` 提示，已标注「480p=样片模式」）。
  ⚠ **CLI 没有视频升级命令**（子命令里只有 `image_upscale` 是图片升级），故「满意后升级高清」只能回即梦网页操作，或在系统里按 720p/1080p **重新生成一版（再扣一次积分）**。
  ⚠ `seedance2.5` 为 **VIP-only**（CLI 原文），`vip_level=standard` 的账号用不了 —— 提交前由 `isVipLevel` 守卫拦截。成本护栏已补 2.5 覆盖档：480p = **9 积分/秒**（网页端 5s/480P/1 条 = 45 积分的观察值），720p/1080p 未实测 → 取「该模型已知最低档」与「通用分辨率档」的较大值（宁可高报不低报）。
- **`image2video` 的 `--image` 只接受本地文件路径**（官方 help 原文「local first-frame image path」）：`workers/submitter.js` 的 `ensureLocalImage` 负责在提交前把远端 URL / `/artifacts/xxx` 落成本地绝对路径，取不到则任务落 `submit_error`（不静默降级）。子命令由「有无首帧图」自动推导：有 → image2video，无 → text2video。
- **调度策略（勿偏离）**：Agnes 免费档打主力（分镜视频全量走 `agnes-video-2.5-flash`），即梦只用于「量少但决定成败」的关键资产（**会过期的每日额度优先花在封面/关键镜头上**）：
  · **角色图**（含全自动成片的 `character` 阶段，由设置项 `dreamina_auto_character` 控制、默认开）走即梦主力档 `jimeng-image-3.1`（1 积分/次 ≈ 4 张候选）；**提交前先预检可用性**（未装 CLI / 未登录 / 非 VIP / 积分不足 → 直接用 Agnes）；
  · **封面 / 关键镜头**可手动升级（任务中心的「⬆ 升级即梦」按钮，需 `retry_count ≥ 3` 且当前为 Agnes）。
  · **即梦视频默认主力 = `seedance2.0mini`**（模型清单首位 → 前端默认选中）：官方定位「极致性价比 · 相近体验 · 比 Fast 快 2 倍」，且单模型覆盖多种模式（文生 / 首尾帧 / 智能多帧 / 全能参考）；`seedance2.0fast` 降为备选同档。✅ **Mini 单价已实测标定（2026-09-24）**：5s / 720p / text2video 实扣 **30 积分**（CLI `list_task` 的 `commerce_info.credit_count=30`、`benefit_type=seedance_20_mini_720p_output_5s`）= **6 积分/秒**，已写入 `DREAMINA_CREDIT_COST.videoByModel` 覆盖（此前按 Fast 同档 5/秒保守估，低报 17%）。
  · **回退规则（v2.6.1，设置项 `dreamina_fallback` 默认开）**：积分不足 / 生成失败 / 非 VIP / 环境未就绪 / 合规闸门 → 由 `core/provider-policy.js` 判定后**自动改投免费档**（原地改 `tasks.model` + `request_json`，状态回 `queued`），**不新增状态与路由**；关闭该设置项即回到「退避并等人工处理」。
  · **反向回退（v2.6.7，设置项 `dreamina_agnes_fallback` 默认关）**：Agnes 免费档**排队失败**（`queue-full` 503 / `rate-limit` 429 / `net` 网络，重试预算耗尽）→ 自动改投即梦 `DREAMINA_FALLBACK_VIDEO_MODEL`（`seedance2.0mini`）继续制作，映射走 `services/payloads.agnesToDreamina()`（组装复用 `buildDreaminaPayload`）。护栏：**带参考图不改投**（Agnes `reference` 与即梦 `image2video` 语义不同）、内容/参数类失败不改投（改了只是花钱）、即梦环境不可用或**积分不足**不改投。判定纯函数在 `provider-policy.shouldFallbackToDreamina()`；账户状态在 submitter 内 60s 缓存（`dreamina.credit()` 要 spawn CLI）。
  · 成本护栏三档（`dreamina_confirm_threshold`，默认 10 积分）：预估 ≤ 阈值静默提交 / > 阈值弹窗确认 / > 剩余积分给出**回退建议**（`fallback` 字段，前端改为告知"将继续并自动改用免费档"）；仅作用于即梦，Agnes 零打扰。
  · 即梦模型**不混入** `/api/meta` 的 `models`（避免污染 Agnes 下拉契约），而是走独立的 `dreamina` 字段供前端分组展示（含按子命令的 `specs`）。
- **e2e 必须隔离即梦**：`test/mock-e2e.js` 在 `require('../server')` 之前把 `DREAMINA_CLI_PATH` 指向不存在的路径，使 `isInstalled()` 返回 false——否则在**本机装了 CLI 且已登录**的环境中，全自动成片的角色图会真实调用即梦并**扣会员积分**。
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
