# 🎬 Agnes Video 任务控制台

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)
![CI](https://img.shields.io/github/actions/workflow/status/AlanNiew/agnes-video-console/ci.yml?label=CI)
![Tests](https://img.shields.io/badge/tests-62%20passed-brightgreen)

本地 Web 工具，接入 [Agnes AI 视频生成 API](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash)，提供**创作工作台（四步流水线）+ 任务队列看板 + 后台自动轮询 + SQLite 本地持久化**的一站式 AI 视频创作体验。

[English README](README.en.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [更新日志](CHANGELOG.md)

支持三个模型（异步任务 API，`POST /v1/videos` 创建、`GET /agnesapi` 轮询）：

| 模型 | 生成模式 | 参数体系 | 价格 | 界面 |
| --- | --- | --- | --- | --- |
| `agnes-video-2.5-flash` | 文生 / 首尾帧 / 多模态参考（图·音·视频） | `seconds` + `size` + `aspect_ratio` | 限时免费 | ✅ 默认 |
| `agnes-video-2.5` | 文生 / 首尾帧 / 多模态参考 | `seconds` + `size` + `aspect_ratio` | 付费 | ✅ 高级分组 |
| `agnes-video-v2.0` | 文生 / 图生 / 关键帧动画 | `num_frames`(8n+1≤441) + `frame_rate` + `width/height` + `negative_prompt` | 限时免费 | ⛔ 已下架（后端兼容保留，历史任务正常显示） |

> 价格与能力以 [Agnes AI 官方文档](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash) 为准，当前 Flash 与 V2.0 模型限时 `$0 / 秒`。

## ✨ 特性

- 🎵 **在线 BGM 配乐（v1.4）**：工作台第⑥步搜索在线曲库（自托管音乐接口，网易云源）→ 试听 → 一键选用；渲染时 BGM 循环铺底、首尾淡入淡出，**有旁白时自动闪避**（sidechaincompress 压低音乐让人声突出），音量可调
- 🎞️ **一键成片渲染（v1.3）**：创作工作台第⑥步把已完成镜头 + 逐镜旁白在本地用 ffmpeg 合成完整短片（叠化转场、旁白按镜头对齐、片头/片尾卡、自动限幅），产出直接播放/下载
- 🚦 **服务端提交队列（v1.3）**：任务创建为「入队」语义，后台提交器按 `submit_interval_ms` 节流提交上游，**429 限流自动指数退避重试**——批量提交不再产生撞墙死记录
- 💾 **视频本地归档（v1.3）**：任务完成即自动下载到 `data/artifacts`，播放/下载优先本地（远端链接过期也有兜底）；历史完成任务启动时自动补扫归档
- 🗑️ **superseded 失败治理（v1.3）**：同镜头已有更新成功任务时，旧失败记录自动标记「已作废」，看板不再被废记录误导
- 📝 **分镜旁白（v1.3）**：分镜生成同步产出每镜旁白文案（可编辑），一键按镜头合成配音（`shot_id` 绑定），成片渲染自动对齐时间轴
- 🔀 **镜头级引用开关（v1.3）**：纯空镜/无人镜头可关闭「引用角色图」，以纯文生模式提交，不再被强制注入角色参考
- 📡 **API 自描述（v1.3）**：`GET /api/openapi.json` 输出机器可读端点文档（自动化脚本 / AI Agent 无需读源码即可对接）；`/api/meta` 附带上游限流提示
- 🎬 **创作工作台（四步流水线）**：一句话创意 → AI 结构化文案（梗概/角色/场景，可编辑多版本）→ AI 角色设定图（定稿）→ 发起视频任务（reference 模式自动引用角色图，`<Picture 1>` 保持角色一致）
- 🎞️ **分镜脚本（M2）**：AI 按创意一次生成多镜头分镜（每镜头标题 + 提示词 + 时长，可选自动/3/5/8 镜），镜头可独立编辑/增删/排序/选用历史版本；支持单镜头提交与「批量提交未完成镜头」（按设置间隔节流），任务按镜头溯源分组
- 🎬 **三模型 · 多模式**：任务中心选模型后表单自动切换参数体系；模型/画幅/时长清单由后端 `/api/meta` 统一下发
- 📋 **任务队列看板**：队列中 / 生成中 / 已完成 / 失败 四列实时看板，进度条、搜索、状态过滤
- 🔄 **后台自动轮询**：可配置间隔（默认 2s）；429 / 网络错误指数退避；超时任务自动标记失败
- 🗄️ **SQLite 本地持久化**：Node 内置 `node:sqlite`，零原生编译；旧库自动迁移、重启不丢
- 🔁 **失败重试**：一键以原参数重新提交（保留失败记录，便于审计）
- ▶️ **视频预览/下载**：完成的任务在看板与详情中直接播放
- 🔍 **任务审计**：完整请求 JSON、创建响应、轮询响应、轮询次数一目了然
- ✍️ **AI 优化提示词**：新建任务时调文本模型把手写描述优化为结构化提示词，优化前后并排对比、由你决定是否采用；工作台角色描述同样支持 AI 优化对比
- 🖼️ **图片多张候选**：角色/场景图支持一次生成 1–4 张，点选其一作为种子图定稿
- 🧭 **流程引导**：步骤条点击跳转、随滚动高亮；「下一步」动态引导条；生成等待分阶段提示；新建项目可一键直达分镜
- 🔐 **密钥安全**：API Key 仅存服务端 SQLite，浏览器只见掩码；服务只监听 `127.0.0.1`
- 🧾 **内置日志面板**：轮询 / 提交事件在前端可视
- ✅ **端到端测试**：内置本地模拟 Agnes API，无需真实 Key 即可验证全链路（40 项断言）

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

**方式一 · 创作工作台（推荐）**：点顶部「🎬 创作工作台」→ 新建项目（一句话创意 + 画幅/时长）→ AI 自动生成文案（可编辑、多版本选用）→「✨ 生成分镜」把创意拆成多镜头（每镜头含旁白文案，可独立编辑/排序；纯空镜镜头可关闭「引用角色图」）→ 生成角色设定图并点选定稿 → 逐镜头「🚀 提交」或「🚀 批量提交未完成镜头」（服务端提交队列按间隔节流，429 自动重试，关闭页面入队任务也会继续提交）→ 第⑤步「🎙️ 配音」逐镜合成旁白 → 第⑥步「🎞️ 成片渲染」一键合成完整短片。

**方式二 · 任务中心（单任务）**：

1. **设置**：填写 API Key、Base URL（默认 `https://apihub.agnes-ai.com`）、轮询间隔、任务超时。
2. **新建任务**：选模型 → 表单自动适配 → 填 prompt → 按模式补充素材 URL（需**可公开访问**的 http(s) 地址，任务完成前保持有效）→ 提交。
3. **看板跟踪**：任务自动流转「队列中 → 生成中 → 已完成/失败」，完成即可播放/下载。
4. **失败处理**：详情查看错误，或一键「重试」（以原参数新建任务）。

**TTS 配音（旁白）**：在「设置」中填写 **Fish Audio API Key**（免费档模型 `s2.1-pro-free`，[官方文档](https://docs.fish.audio)）→ 创作工作台项目第⑤步「🎙️ 配音」：粘贴文稿（支持逐句换行）→ 选音色/语速 → 生成 → 浏览器试听/选用/删除。旁白支持逐镜头绑定（分镜卡片中填写旁白 → 生成配音，`shot_id` 自动关联），成片渲染时按镜头对齐时间轴混入。接口：`POST /api/tts/generate`、`GET /api/tts/voices`、`POST /api/tts/:id/select`、`DELETE /api/tts/:id`。

**成片渲染**：第⑥步「🎞️ 成片渲染」把已完成镜头视频（本地归档优先）与逐镜旁白合成为完整短片——镜头间叠化转场（可调 0.4–1.0s）、旁白按镜头起幅点对齐（偏移可调）、可选片头/片尾卡、混音自动限幅；1280×720@30 输出到 `data/artifacts/`，完成后页面内直接播放/下载。需要本机安装 **ffmpeg**（加入 PATH）。接口：`POST /api/projects/:id/render`、`GET /api/projects/:id/render/jobs`、`GET /api/render/jobs/:id`、`DELETE /api/render/jobs/:id`。

**BGM 配乐（v1.4）**：在「设置 → 音乐接口」填写自托管音乐接口地址与 Token（网易云源；Token 仅存本地 SQLite、只做服务端调用）→ 第⑥步「🎵 背景音乐」搜索歌曲 → ▶ 试听（服务端流代理，现取现播）→ 选用（立即下载到 `data/artifacts` 缓存，播放地址有时效性因此落本地）→ 渲染成片时自动循环铺底、首尾淡入淡出；有旁白时默认开启「旁白闪避」，BGM 音量可调（有旁白建议 30–40%）。接口：`GET /api/music/search`、`GET /api/music/stream`、`POST/DELETE /api/projects/:id/bgm`。

**V2.0 提示**（仅历史任务/后端 API，界面已下架）：时长 = `num_frames ÷ frame_rate`（如 121÷24 ≈ 5s）；`num_frames` 需 ≤441 且满足 8n+1（81/121/241/441）。

**提示词建议**：主体与场景 → 动作变化 → 镜头语言 → 视觉风格 → 声音节奏 → 一致性要求。`reference` 模式用 `<Picture 1>` / `<Audio 1>` / `<Video 1>` 指代素材。

## 🏗️ 项目结构

```
agnes-video-console/
├── server.js            # Express API + 参数校验（按模型家族分发）+ 流水线端点 + TTS 端点 + 成片渲染端点 + 静态服务
├── db.js                # SQLite 数据层（任务/项目/文案/图片/镜头/配音/渲染任务表 + 自动迁移 + 事务）
├── agnes.js             # Agnes API 客户端（视频创建/查询 / chat / 图片）
├── submitter.js         # 后台提交器（v1.3：按 submit_interval_ms 服务端节流，429 自动退避重试）
├── poller.js            # 后台轮询器（退避 / 超时 / 完成视频自动归档 / 启动补扫）
├── render.js            # 成片渲染器（v1.3：归一化 → xfade 叠化 → 旁白对齐混音 → 片头尾卡）
├── artifacts.js         # 本地产物归档（远程图片/视频/音频下载备份，供 server/poller 共用）
├── openapi.js           # API 自描述文档（GET /api/openapi.json）
├── netmusic.js          # 音乐接口客户端（v1.4 BGM：搜索 / 播放地址 / 本地缓存下载）
├── fish-tts.js          # Fish Audio TTS 客户端（直连或 HTTP 代理 CONNECT 隧道）
├── logger.js            # 内存环形日志
├── public/              # 前端单页应用（index.html / style.css / app.js 任务中心 / workspace.js 创作工作台）
├── test/mock-e2e.js     # 端到端冒烟测试（本地模拟 Agnes API，含 429 限流与真实 ffmpeg 渲染用例）
└── data/                # 运行时生成：agnes-console.db + artifacts 本地归档（已被 .gitignore 忽略）
```

## 📡 本工具自带 API

```
GET  /api/health                       健康检查
GET  /api/openapi.json                 API 自描述文档（v1.3，机器可读）
GET  /api/meta                         模型/画幅/时长元数据（含上游限流提示）
GET  /api/settings                     获取设置（API Key 仅返回掩码）
PUT  /api/settings                     保存设置
GET  /api/stats                        按状态统计
GET  /api/tasks?status=&q=&limit=      任务列表（过滤 / 搜索 / 分页）
POST /api/tasks                        创建任务（含模式规则校验）
GET  /api/tasks/:id                    任务详情
POST /api/tasks/:id/retry              失败重试（新建任务记录）
POST /api/tasks/:id/poll               立即强制轮询
DELETE /api/tasks/:id                  删除任务
POST /api/tasks/bulk/clear-completed   清空已完成
POST /api/tasks/bulk/clear-failed      清空失败
GET  /api/logs                         最近运行日志
POST /api/llm/chat                     通用文本生成（提示词优化）
POST /api/llm/script                   创意 → 结构化文案（可关联项目落库）
POST /api/llm/storyboard               创意 → 多镜头分镜（可关联项目，重建镜头工作副本）
POST /api/images/generate              图片生成（文生图/图生图，可关联项目）
DELETE /api/images/:id                 删除项目图片记录
POST /api/projects                     创建创作项目
GET  /api/projects                     项目列表
GET  /api/projects/:id                 项目详情（聚合文案/图片/镜头/任务）
PATCH /api/projects/:id                更新项目
DELETE /api/projects/:id               删除项目（级联清理文案/图片/镜头，任务解绑）
POST /api/projects/:id/select-text     选定文案版本
PATCH /api/projects/:id/texts/:textId  编辑文案内容（校验归属）
POST /api/projects/:id/select-image    定稿角色/场景图
POST /api/projects/:id/storyboard/apply 选用历史分镜版本（重建镜头）
POST /api/projects/:id/shots           手动添加镜头
PATCH /api/projects/:id/shots/:shotId  编辑镜头（校验归属）
DELETE /api/projects/:id/shots/:shotId 删除镜头
POST /api/projects/:id/shots/reorder   镜头排序
POST /api/projects/:id/videos          从项目发起视频任务（旧入口，单提示词）
POST /api/projects/:id/shots/:shotId/videos  单镜头提交视频任务
POST /api/projects/:id/render          一键成片渲染（镜头视频 + 逐镜旁白 + BGM → 完整短片）
GET  /api/projects/:id/render/jobs     项目渲染任务列表
GET  /api/render/jobs/:id              渲染任务详情（进度/产物）
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

期望输出 `== 全部通过 ✔ ==`（当前 **62 项**断言，覆盖任务全链路、提交队列、本地归档、superseded 治理、流水线、分镜旁白、成片渲染、BGM 配乐、输入校验与安全约束）。CI（GitHub Actions）也会在每次 push / PR 时自动执行。

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