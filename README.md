# 🎬 Agnes Video 任务控制台

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)
![CI](https://img.shields.io/github/actions/workflow/status/AlanNiew/agnes-video-console/ci.yml?label=CI)
![Tests](https://img.shields.io/badge/tests-74%20unit%20%2B%2072%20e2e-brightgreen)
本地 Web 工具，接入 [Agnes AI 视频生成 API](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash)，提供**创作工作台（六步流水线 + 全自动成片）+ 任务中心（视频/图片统一列表）+ 后台自动轮询 + SQLite 本地持久化**的一站式 AI 视频创作体验。

[English README](README.en.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [更新日志](CHANGELOG.md)

支持三个模型（异步任务 API，`POST /v1/videos` 创建、`GET /agnesapi` 轮询）：

| 模型                    | 生成模式                                 | 参数体系                                                                   | 价格     | 界面                                        |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| `agnes-video-2.5-flash` | 文生 / 首尾帧 / 多模态参考（图·音·视频） | `seconds` + `size` + `aspect_ratio`                                        | 限时免费 | ✅ 默认                                     |
| `agnes-video-2.5`       | 文生 / 首尾帧 / 多模态参考               | `seconds` + `size` + `aspect_ratio`                                        | 付费     | ✅ 高级分组                                 |
| `agnes-video-v2.0`      | 文生 / 图生 / 关键帧动画                 | `num_frames`(8n+1≤441) + `frame_rate` + `width/height` + `negative_prompt` | 限时免费 | ⛔ 已下架（后端兼容保留，历史任务正常显示） |

> 价格与能力以 [Agnes AI 官方文档](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash) 为准，当前 Flash 与 V2.0 模型限时 `$0 / 秒`。

## ✨ 特性

- 🚀 **全自动成片（v2.0）**：新建项目勾选「🚀 全自动成片」，从创意到成片全自动推进——文案 → 分镜 → AI 自审 → 角色图 → 逐镜视频 → 配音 → **自动选配乐（v2.1：按风格选曲，默认纯轻音乐）** → 渲染，失败自动重试、失败镜头自动重拍、TTS 不可用自动跳过，卡住停在人工介入点可一键重启；进度时间线实时可视化
- 🎨 **图片任务统一（v2.0）**：新建任务「生成视频 / 生成图片」双入口；图片任务与视频任务共用任务中心列表 / 详情 / 重试 / 下载（异步后台生成 + 退避重试 + 本地归档），支持不挂项目的独立创作
- 📋 **任务中心时间线列表（v2.0）**：全部任务单列表按创建时间倒序（类型/状态徽章 + 进度 + 失败原因 + 相对时间），真分页（每页 10/20/50 条）；每行带「📁 来源」徽章（所属项目名、镜头序号与标题、角色图/场景图、独立创作）；四列看板保留为可切换视图
- 🎬 **成片风格预设（v2.0）**：治愈慢综 / 热血快剪 / 纪录解说 / 知识口播 / 童话绘本一键套用整套渲染配方；高级配置面板支持转场类型（7 种）/ 字幕样式（3 种）/ 字幕位置 / 音频微调，小白也能剪出专业成片；**渲染前预检面板（v2.1）**实时提示镜头就绪 / 旁白时长匹配 / 配乐状态 / 预计时长
- 🔍 **AI 自审与质检（v2.0）**：分镜生成后可一键「AI 审查分镜」（一致性/节奏/提示词质量 → 结构化修订建议，逐条采纳）；渲染完成自动产出质检报告（时长偏差 / 响度 LUFS / 旁白覆盖 / 字幕行数）
- 🧭 **分步向导（v2.0）**：创作工作台每步带「💡 这一步做什么」新手说明卡 + 上一步/下一步导航（带前置校验）+ 完成度计数；新建项目风格卡片化（8 种预设）
- 📱 **竖屏 9:16 产线 + 封面自动生成（v1.8）**：渲染方向跟随项目画幅（16:9 横屏 / 9:16 竖屏直通抖音快手），字卡/字幕/安全边距全链自适应；渲染完成自动产出 3 张封面候选（关键帧 + 片名），工作台直接预览下载
- 🎵 **在线 BGM 配乐（v1.4）**：工作台第⑥步搜索在线曲库（自托管音乐接口，网易云源）→ 试听 → 一键选用；渲染时 BGM 循环铺底、首尾淡入淡出，**有旁白时自动闪避**（sidechaincompress 压低音乐让人声突出），音量可调
- 🎞️ **一键成片渲染（v1.3）**：创作工作台第⑥步把已完成镜头 + 逐镜旁白在本地用 ffmpeg 合成完整短片（转场可选、旁白按镜头对齐、片头/片尾卡、响度标准化），产出直接播放/下载
- 📁 **作品归档 + 社交海报（v2.2）**：每部成品独立目录 `data/works/《作品名》-ID/`（成片 / SRT 字幕 / 旁白台词 / AI 海报），渲染完成自动生成可直发社交平台的海报（LLM 海报级提示词 → 文生图 → 叠片名标题），与素材目录彻底分开
- 🏆 **作品库页面（v2.2）**：顶部「🏆 我的作品」直接在网页浏览全部成品——海报封面卡片墙，点击进详情弹窗：内嵌播放器 + 全套下载（成片/海报/字幕/台词）+ 质检徽章 + 复制目录路径，成品再也不用到本地目录翻找
- 🚦 **服务端提交队列（v1.3）**：任务创建为「入队」语义，后台提交器按 `submit_interval_ms` 节流提交上游，**429 限流自动指数退避重试**——批量提交不再产生撞墙死记录
- 💾 **视频本地归档（v1.3）**：任务完成即自动下载到 `data/artifacts`，播放/下载优先本地（远端链接过期也有兜底）；历史完成任务启动时自动补扫归档
- 🗑️ **superseded 失败治理（v1.3）**：同镜头已有更新成功任务时，旧失败记录自动标记「已作废」，看板不再被废记录误导
- 📝 **分镜旁白（v1.3）**：分镜生成同步产出每镜旁白文案（可编辑），一键按镜头合成配音（`shot_id` 绑定），成片渲染自动对齐时间轴
- 🔀 **镜头级引用开关（v1.3）**：纯空镜/无人镜头可关闭「引用角色图」，以纯文生模式提交，不再被强制注入角色参考
- 📡 **API 自描述（v1.3）**：`GET /api/openapi.json` 输出机器可读端点文档（自动化脚本 / AI Agent 无需读源码即可对接）；`/api/meta` 附带上游限流提示
- 🎬 **创作工作台（六步流水线）**：一句话创意 → AI 结构化文案（梗概/角色/场景，可编辑多版本）→ AI 角色设定图（定稿）→ 发起视频任务（reference 模式自动引用角色图，`<Picture 1>` 保持角色一致）
- 🎞️ **分镜脚本（M2）**：AI 按创意一次生成多镜头分镜（每镜头标题 + 提示词 + 时长，可选自动/3/5/8 镜），镜头可独立编辑/增删/排序/选用历史版本；支持单镜头提交与「批量提交未完成镜头」（按设置间隔节流），任务按镜头溯源分组
- 🎬 **三模型 · 多模式**：任务中心选模型后表单自动切换参数体系；模型/画幅/时长清单由后端 `/api/meta` 统一下发
- 🔄 **后台自动轮询**：可配置间隔（默认 2s）；429 / 网络错误指数退避；超时任务自动标记失败
- 🗄️ **SQLite 本地持久化**：Node 内置 `node:sqlite`，零原生编译；旧库自动迁移、重启不丢
- 🔁 **失败重试（v2.1 原地重试）**：一键重新排队，原任务状态重走 队列中→生成中→完成/失败 完整流转（ID 不变，重试次数可查），不再产生废弃的失败残留记录
- ▶️ **视频预览/下载**：完成的任务在列表与详情中直接播放；图片任务展示缩略图墙
- 🔍 **任务审计**：完整请求 JSON、创建响应、轮询响应、轮询次数一目了然
- ✍️ **AI 优化提示词**：新建任务时调文本模型把手写描述优化为结构化提示词（视频六段式 / 图片五段式），优化前后并排对比、由你决定是否采用；工作台角色描述同样支持 AI 优化对比
- 🖼️ **图片多张候选**：角色/场景图支持一次生成 1–4 张，点选其一作为种子图定稿
- 🔐 **密钥安全**：API Key 仅存服务端 SQLite，浏览器只见掩码；服务只监听 `127.0.0.1`
- 🧾 **内置日志面板**：轮询 / 提交事件在前端可视
- ✅ **端到端测试**：内置本地模拟 Agnes API，无需真实 Key 即可验证全链路（72 项断言，含全自动成片闭环）；另有 **74 项单元测试**（jest：payload 校验矩阵 / LLM 解析 / ASS 字幕 / 退避数学），`npm test` 一键全跑

## 🚀 快速开始

要求：**Node.js ≥ 22.13**（使用内置 `node:sqlite`，零原生依赖）。

```bash
git clone <repo-url> && cd agnes-video-console
npm install           # 若 npm 缓存目录不可写，可加 --cache ./.npm-cache
npm start
```

打开 **http://127.0.0.1:8273**，点右上角 ⚙ 设置填入 Agnes API Key 即可开始。

> 端口可用环境变量覆盖：`PORT=9000 npm start`。

## 📖 使用流程

**方式一 · 全自动成片（小白推荐，v2.0）**：新建项目时勾选「🚀 全自动成片」→ 填一句创意 + 选风格卡片 → 之后**什么都不用做**：文案、分镜、AI 自审修订、角色图、逐镜视频、逐镜配音、渲染全链自动推进（失败自动重试、TTS 未配置自动跳过）；页面顶部进度时间线实时显示每个阶段，卡住时停在「人工介入」点，处理完可一键重新启动。

**方式二 · 创作工作台（逐步精修）**：点顶部「🎬 创作工作台」→ 新建项目（一句话创意 + 风格卡片 + 画幅/时长）→ AI 自动生成文案（可编辑、多版本选用）→「✨ 生成分镜」把创意拆成多镜头（可「🔍 AI 审查分镜」获得修订建议并逐条采纳）→ 生成角色设定图并点选定稿 → 逐镜头「🚀 提交」或「🚀 批量提交未完成镜头」（服务端提交队列按间隔节流，429 自动重试，关闭页面入队任务也会继续提交）→ 第⑤步「🎙️ 配音」逐镜合成旁白 → 第⑥步「🎞️ 成片渲染」选风格预设或高级配置后一键合成完整短片。

**方式三 · 任务中心（单任务）**：

1. **设置**：填写 API Key、Base URL（默认 `https://apihub.agnes-ai.com`）、轮询间隔、任务超时。
2. **新建任务**：选「🎬 生成视频 / 🖼️ 生成图片」→ 视频选模型/模式填 prompt（可 AI 优化），图片填描述选分辨率/画幅/张数 → 提交。
3. **列表跟踪**：时间线列表按创建时间倒序展示全部任务（状态筛选 + 搜索 + 分页），自动流转「队列中 → 生成中 → 已完成/失败」，完成即可播放/下载；右上角可切换回看板视图。
4. **失败处理**：详情查看错误，或一键「重试」（视频/图片任务均可，以原参数新建任务）。

**TTS 配音（旁白）**：在「设置」中填写 **Fish Audio API Key**（免费档模型 `s2.1-pro-free`，[官方文档](https://docs.fish.audio)）→ 创作工作台第⑤步「🎙️ 配音」：**推荐「🎙️ 为所有镜头生成配音」**——按每镜「旁白文案」（第②步分镜卡片中填写）逐条合成并自动绑定镜头，渲染时与画面自动对齐；也可在每张镜头卡上单镜配音，或用「自由文稿」整段合成（不绑镜头）。配音墙可试听/重生成/重新绑定。接口：`POST /api/tts/generate`、`GET /api/tts/voices`、`POST /api/tts/:id/select`、`DELETE /api/tts/:id`。

**成片渲染**：第⑥步「🎞️ 成片渲染」把已完成镜头视频（本地归档优先）与逐镜旁白合成为完整短片——选风格预设（一键套用转场/字幕/音频整套配方）或展开「高级配置」微调：转场类型（淡入淡出/溶解/擦除/滑动/圆形展开）与时长、字幕样式（白字描边/金字底框/底部字幕条）与位置字号、旁白偏移对齐、可选片头/片尾卡；混音链含响度标准化（-16 LUFS）；1280×720@30 输出到 `data/artifacts/`，完成后页面内直接播放/下载并附质检报告与 3 张封面候选。需要本机安装 **ffmpeg**（加入 PATH）。接口：`POST /api/projects/:id/render`、`GET /api/projects/:id/render/jobs`、`GET /api/render/jobs/:id`、`DELETE /api/render/jobs/:id`。

**BGM 配乐（v1.4）**：在「设置 → 音乐接口」填写自托管音乐接口地址与 Token（网易云源；Token 仅存本地 SQLite、只做服务端调用）→ 第⑥步「🎵 背景音乐」搜索歌曲 → ▶ 试听（服务端流代理，现取现播）→ 选用（立即下载到 `data/artifacts` 缓存，播放地址有时效性因此落本地）→ 渲染成片时自动循环铺底、首尾淡入淡出；有旁白时默认开启「旁白闪避」，BGM 音量可调（有旁白建议 30–40%）。接口：`GET /api/music/search`、`GET /api/music/stream`、`POST/DELETE /api/projects/:id/bgm`。

**V2.0 提示**（仅历史任务/后端 API，界面已下架）：时长 = `num_frames ÷ frame_rate`（如 121÷24 ≈ 5s）；`num_frames` 需 ≤441 且满足 8n+1（81/121/241/441）。

**提示词建议**：主体与场景 → 动作变化 → 镜头语言 → 视觉风格 → 声音节奏 → 一致性要求。`reference` 模式用 `<Picture 1>` / `<Audio 1>` / `<Video 1>` 指代素材。

## 🏗️ 项目结构

```
agnes-video-console/
├── server.js            # Express 装配 + 静态服务 + 统一错误中间件 + 启动编排（单实例锁 / 优雅退出）
├── core/                # 零/低依赖基元：constants（模型清单/白名单/上限/转场与字幕预设）· config（跨模块单源常量）· errors（ApiError/ah）· logger（内存环形日志）· openapi（API 自描述）
├── clients/             # 上游客户端：agnes（视频/chat/图片 API）· fish-tts（TTS，CONNECT 隧道）· netmusic（BGM 音乐接口）
├── services/            # 业务层：payloads（请求体校验）· task-queue（任务入队）· prompts · subtitles（字幕纯函数）· voice-pool + pipeline（DI 编排）
├── lib/                 # 本地文件/产物支撑：artifacts（素材备份 artifacts + works 作品目录定位）· poster（社交海报）
├── db/                  # 数据层：kernel.js（连接/DDL/迁移/tx）· sql.js（prepare 注册表）· repos/（settings/tasks/projects/renders 表族仓库）· index.js 组合出口（require('./db') 目录解析指向）
├── instance-lock.js     # 单实例工作锁（settings 键原子 CAS，跨进程互斥；M3 自数据层拆出）
├── workers/             # 后台进程（单实例工作锁约束）：submitter（提交节流 + 429 退避）· poller（轮询归档）· image-worker（图片任务）· render（成片渲染器）· auto（全自动成片编排器）· manager（worker 统一启停/唤醒）
├── routes/              # 按领域拆分的 API 路由（meta / settings / tasks / llm / images / tts / music / projects / render）
├── public/              # 前端单页应用（index.html / common.js 公共工具 / app.js 任务中心 / workspace.js 创作工作台）
├── test/unit/           # 单元测试（jest：payload 校验 / LLM 解析 / ASS 字幕 / 退避数学）
├── test/mock-e2e.js     # 端到端冒烟测试（本地模拟 Agnes API，含 429 限流、图片任务、全自动成片与真实 ffmpeg 渲染用例）
└── data/                # 运行时生成：agnes-console.db + artifacts 素材归档 + works 作品目录（gitignore 忽略）
```

> **找成品**：网页顶部「🏆 我的作品」直接浏览/播放/下载全部成品；本地目录在 `data/works/《作品名》-项目ID/`（工作台第⑦步渲染卡也显示确切路径）。

> 开发命令：`npm test`（jest 单测 + e2e 冒烟全跑）；`npm run test:unit` / `npm run test:mock` 单独跑；`npm run lint` / `npm run format` 代码检查与格式化；`npm run build` 前端构建（vite → dist/，M4-B0）。

## 📡 本工具自带 API

```
GET  /api/health                       健康检查
GET  /api/works                        作品库（全部成品汇总：成片/海报/字幕/台词 + 质检）
GET  /api/openapi.json                 API 自描述文档（v1.3，机器可读）
GET  /api/meta                         模型/画幅/时长元数据（含上游限流提示）
GET  /api/settings                     获取设置（API Key 仅返回掩码）
PUT  /api/settings                     保存设置
GET  /api/stats                        按状态统计
GET  /api/tasks?status=&q=&limit=&offset=  任务列表（过滤 / 搜索 / 分页，返回 total 总数）
POST /api/tasks                        创建任务（含模式规则校验）
GET  /api/tasks/:id                    任务详情（kind 区分 video|image）
POST /api/tasks/:id/retry              失败重试（v2.1：原任务原地重新排队，ID 不变；视频/图片任务均可）
POST /api/tasks/:id/poll               立即强制轮询
DELETE /api/tasks/:id                  删除任务
POST /api/tasks/bulk/clear-completed   清空已完成
POST /api/tasks/bulk/clear-failed      清空失败
GET  /api/logs                         最近运行日志
POST /api/llm/chat                     通用文本生成（提示词优化）
POST /api/llm/script                   创意 → 结构化文案（可关联项目落库）
POST /api/llm/storyboard               创意 → 多镜头分镜（可关联项目，重建镜头工作副本）
POST /api/images/generate              图片生成（同步，文生图/图生图，可关联项目）
POST /api/images/tasks                 图片生成任务（异步·v2.0，入队即返回，后台工作器执行）
DELETE /api/images/:id                 删除项目图片记录
POST /api/projects                     创建创作项目
GET  /api/projects                     项目列表
GET  /api/projects/:id                 项目详情（聚合文案/图片/镜头/任务）
PATCH /api/projects/:id                更新项目
DELETE /api/projects/:id               删除项目（级联清理文案/图片/镜头，任务解绑）
POST /api/projects/:id/auto            启动全自动成片（v2.0：文案→分镜→自审→角色图→视频→配音→渲染）
GET  /api/projects/:id/auto            全自动成片状态（进度时间线数据源）
POST /api/projects/:id/auto/stop       停止全自动成片（已完成内容保留）
POST /api/projects/:id/select-text     选定文案版本
PATCH /api/projects/:id/texts/:textId  编辑文案内容（校验归属）
POST /api/projects/:id/select-image    定稿角色/场景图
POST /api/projects/:id/storyboard/apply 选用历史分镜版本（重建镜头）
POST /api/projects/:id/storyboard/review AI 审查分镜（v2.0：一致性/节奏/质量 → 修订建议）
POST /api/projects/:id/shots           手动添加镜头
PATCH /api/projects/:id/shots/:shotId  编辑镜头（校验归属）
DELETE /api/projects/:id/shots/:shotId 删除镜头
POST /api/projects/:id/shots/reorder   镜头排序
POST /api/projects/:id/videos          从项目发起视频任务（旧入口，单提示词）
POST /api/projects/:id/shots/:shotId/videos  单镜头提交视频任务
POST /api/projects/:id/render          一键成片渲染（镜头视频 + 逐镜旁白 + BGM → 完整短片）
GET  /api/projects/:id/render/jobs     项目渲染任务列表
GET  /api/render/jobs/:id              渲染任务详情（进度/产物/质检报告）
DELETE /api/render/jobs/:id            删除渲染任务（产物一并清理）
GET  /api/music/search                 在线曲库搜索（BGM，v1.4）
GET  /api/music/stream                 歌曲试听流代理（现取播放地址转发）
POST /api/projects/:id/bgm             项目选用 BGM（下载缓存 + 落库）
DELETE /api/projects/:id/bgm           清除项目 BGM 选择
GET  /artifacts/*                      本地产物静态服务（图片/视频/音频/成片）
```

## 🧪 测试

无需真实 API Key——内置本地模拟 Agnes API，验证「创建 → 入队 → 提交（含 429 自动重试）→ 轮询 → 归档 → 渲染成片」完整闭环，以及各模型参数校验规则（有 ffmpeg 的环境会执行真实渲染断言）：

```bash
npm run test:mock
```

期望输出 `== 全部通过 ✔ ==`（当前 **72 项**断言，覆盖任务全链路、提交队列、本地归档、superseded 治理、异步图片任务、分页 total、流水线、分镜旁白、L1 分镜审查、全自动成片闭环、成片渲染与质检报告、BGM 配乐、专业混音链、字幕烧录、多镜头重拍、输入校验与安全约束）。CI（GitHub Actions）也会在每次 push / PR 时自动执行。

## 🔒 安全说明

- 服务只绑定 `127.0.0.1`，不对局域网/公网开放。
- API Key 明文存于本地 SQLite（`data/agnes-console.db`），仅服务端调用 API 使用；浏览器仅见掩码。
- **切勿**将 `data/` 目录、数据库文件或 API Key 提交到任何仓库（`.gitignore` 已排除）。
- 建议使用最小权限 API Key 并定期轮换。
- 漏洞报告请走 GitHub 私有漏洞报告，参见 [SECURITY.md](SECURITY.md)。

## ❓ 常见问题

- **启动时出现 ExperimentalWarning**：Node 内置 SQLite 为实验特性，仅提示不影响使用。
- **任务一直「队列中」**：检查是否已填 API Key；查看「日志」面板中的轮询事件（429 退避 / 鉴权失败）。
- **npm install 报 EPERM**：npm 全局缓存不可写时，用 `npm install --cache ./.npm-cache`。
- **视频地址打不开**：确认输出 URL 可公开访问（部分平台对热链接有限制）；可在详情页复制 `metadata_url` 手动下载。

## 🤝 贡献

欢迎提交 Issue 与 Pull Request！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（提交信息遵循 Conventional Commits，改动需通过 `npm run test:mock`）。

## 📄 许可

[MIT](LICENSE) © AlanNiew

## 🙏 致谢

- [Agnes AI](https://www.agnes-ai.com) —— 免费多模态 AI API 平台与官方文档
- 本项目与 Agnes AI 无隶属关系，模型能力与价格以官方为准
