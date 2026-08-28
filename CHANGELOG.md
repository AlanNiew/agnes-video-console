# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 计划中的功能（欢迎在 issue 中提出建议）。

## [1.0.1] - 2025-07-17

### Fixed

- **任务列表接口占位符参数缺失**：SQL 有 6 个占位符但只绑定 5 个参数，导致 `/api/tasks` 始终返回空数组（看板看不到任何任务，即使统计栏有计数）。已修复并加入回归测试。
- **兼容真实 API 的 `pending` 状态**：真实接口在排队等待时返回 `status: pending`（文档未提及），原逻辑会误判为 `failed` 且不产生任何日志。现在 `pending/processing/running` 一律按“队列中”继续轮询，不会误杀。
- **兼容真实 API 的顶层 `url` 字段**：实测完成响应中视频地址位于顶层 `url`（文档写的是 `metadata.url`），现在两者都兼容，已完成任务能正确显示/播放视频。

### Changed

- 状态筛选 chips 现在真正生效：选中某个状态时看板只显示该列（单列聚焦视图），「全部」显示四列。
- 提交任务失败后立即刷新看板，`submit_error` 任务马上出现在「失败」列。

## [1.0.0] - 2025-07-17

### Added

- 接入 Agnes AI 视频生成 API，支持三个模型：
  - `agnes-video-2.5-flash`（免费）：文生 / 首尾帧 / 多模态参考（图片、音频、视频），仅 720P。
  - `agnes-video-v2.0`（免费）：文生 / 图生 / 关键帧动画（`extra_body.keyframes`），480p–1080p。
  - `agnes-video-2.5`（付费）：文生 / 首尾帧 / 多模态参考，720P/960P/2K。
- 任务队列看板：队列中 / 生成中 / 已完成 / 失败 四列实时看板，搜索与状态过滤。
- 后台自动轮询：可配置间隔（默认 2s）、429/网络错误指数退避、超时自动标记失败。
- SQLite 本地持久化：任务、设置、API Key 全部落库（Node 内置 `node:sqlite`，零原生依赖），旧库自动迁移。
- 失败任务一键重试（以原参数新建任务记录，保留审计历史）。
- 完成视频在线预览 / 下载；任务详情完整展示请求 JSON、创建响应、轮询响应。
- API Key 安全：仅服务端持有，浏览器仅见掩码；服务默认只监听 `127.0.0.1`。
- 内置内存日志面板；端到端冒烟测试（本地模拟 Agnes API，无需真实 Key）。