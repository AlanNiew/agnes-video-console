# Contributing / 贡献指南

感谢你愿意贡献！请遵循以下约定，让项目保持高质量、易维护。

## 提交规范 / Commit Convention

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
feat: 新增功能
fix: 修复缺陷
docs: 仅文档变更
refactor: 重构（不改变行为）
perf: 性能优化
test: 测试相关
chore: 构建/工具链等杂项
```

示例：`feat: support agnes-video-v2.0 keyframes mode`

## 开发环境 / Development Setup

```bash
# 需要 Node.js >= 22.13（依赖内置 node:sqlite）
npm install
npm start          # 启动开发服务 → http://127.0.0.1:8273
```

## 测试 / Running Tests

```bash
npm run test:mock
```

`test:mock` 会启动一个本地模拟 Agnes API 服务器，完整验证
「创建任务 → 后台轮询 → 完成并取回视频地址」闭环，无需真实 API Key。
所有改动请在合并前确保测试全部通过（输出 `== 全部通过 ✔ ==`）。

## 代码约定 / Code Style

- 使用 CommonJS（本项目未启用 ESM）。
- 遵循 `.editorconfig`（2 空格缩进、UTF-8、LF）。
- 服务端新增接口请保持 RESTful 风格并补充合理的中文错误信息。
- 涉及 Agnes API 的参数务必对照官方文档校验（模型/模式/字段限制）。

## 提交流程 / Workflow

1. Fork 本仓库并创建功能分支（`feat/xxx` 或 `fix/xxx`）。
2. 小步提交，信息清晰（见上文提交规范）。
3. 确保测试通过，必要时补充用例（`test/mock-e2e.js`）。
4. 发起 Pull Request，附上变更说明与验证结果。
