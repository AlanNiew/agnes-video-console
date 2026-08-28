# 🎬 Agnes Video 任务控制台

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)
![CI](https://img.shields.io/github/actions/workflow/status/AlanNiew/agnes-video-console/ci.yml?label=CI)
![Tests](https://img.shields.io/badge/tests-18%20passed-brightgreen)

本地 Web 工具，接入 [Agnes AI 视频生成 API](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash)，用**任务队列看板 + 后台自动轮询 + SQLite 本地持久化**一站式管理视频生成任务。

[English README](README.en.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [更新日志](CHANGELOG.md)

支持三个模型（异步任务 API，`POST /v1/videos` 创建、`GET /agnesapi` 轮询）：

| 模型 | 生成模式 | 参数体系 | 价格 |
| --- | --- | --- | --- |
| `agnes-video-2.5-flash` | 文生 / 首尾帧 / 多模态参考（图·音·视频） | `seconds` + `size` + `aspect_ratio` | 限时免费 |
| `agnes-video-v2.0` | 文生 / 图生 / 关键帧动画 | `num_frames`(8n+1≤441) + `frame_rate` + `width/height` + `negative_prompt` | 限时免费 |
| `agnes-video-2.5` | 文生 / 首尾帧 / 多模态参考 | `seconds` + `size` + `aspect_ratio` | 付费 |

> 价格与能力以 [Agnes AI 官方文档](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash) 为准，当前 Flash 与 V2.0 模型限时 `$0 / 秒`。

## ✨ 特性

- 🎬 **三模型 · 多模式**：选模型后表单自动切换为该模型的参数体系（2.5 系列 vs V2.0）
- 📋 **任务队列看板**：队列中 / 生成中 / 已完成 / 失败 四列实时看板，进度条、搜索、状态过滤
- 🔄 **后台自动轮询**：可配置间隔（默认 2s）；429 / 网络错误指数退避；超时任务自动标记失败
- 🗄️ **SQLite 本地持久化**：Node 内置 `node:sqlite`，零原生编译；旧库自动迁移、重启不丢
- 🔁 **失败重试**：一键以原参数重新提交（保留失败记录，便于审计）
- ▶️ **视频预览/下载**：完成的任务在看板与详情中直接播放
- 🔍 **任务审计**：完整请求 JSON、创建响应、轮询响应、轮询次数一目了然
- 🔐 **密钥安全**：API Key 仅存服务端 SQLite，浏览器只见掩码；服务只监听 `127.0.0.1`
- 🧾 **内置日志面板**：轮询 / 提交事件在前端可视
- ✅ **端到端测试**：内置本地模拟 Agnes API，无需真实 Key 即可验证全链路

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

1. **设置**：填写 API Key、Base URL（默认 `https://apihub.agnes-ai.com`）、轮询间隔、任务超时。
2. **新建任务**：选模型 → 表单自动适配 → 填 prompt → 按模式补充素材 URL（需**可公开访问**的 http(s) 地址，任务完成前保持有效）→ 提交。
3. **看板跟踪**：任务自动流转「队列中 → 生成中 → 已完成/失败」，完成即可播放/下载。
4. **失败处理**：详情查看错误，或一键「重试」（以原参数新建任务）。

**V2.0 提示**：时长 = `num_frames ÷ frame_rate`（如 121÷24 ≈ 5s）；`num_frames` 需 ≤441 且满足 8n+1（81/121/241/441）。

**提示词建议**：主体与场景 → 动作变化 → 镜头语言 → 视觉风格 → 声音节奏 → 一致性要求。`reference` 模式用 `<Picture 1>` / `<Audio 1>` / `<Video 1>` 指代素材。

## 🏗️ 项目结构

```
agnes-video-console/
├── server.js            # Express API + 参数校验（按模型家族分发）+ 静态服务
├── db.js                # SQLite 数据层（任务表 / 设置表 / 自动迁移）
├── agnes.js             # Agnes API 客户端（创建 / 查询）
├── poller.js            # 后台轮询器（退避 / 超时 / 悬挂任务清理）
├── logger.js            # 内存环形日志
├── public/              # 前端单页应用（index.html / style.css / app.js）
├── test/mock-e2e.js     # 端到端冒烟测试（本地模拟 Agnes API）
└── data/                # 运行时生成：agnes-console.db（已被 .gitignore 忽略）
```

## 📡 本工具自带 API

```
GET  /api/health                       健康检查
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
```

## 🧪 测试

无需真实 API Key——内置本地模拟 Agnes API，验证「创建 → 轮询 → 完成取回视频地址」完整闭环，以及各模型参数校验规则：

```bash
npm run test:mock
```

期望输出 `== 全部通过 ✔ ==`（当前 18 项）。CI（GitHub Actions）也会在每次 push / PR 时自动执行。

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