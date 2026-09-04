# 前端改造专项（M4）· 实施蓝图

> 状态：**B0 已交付**（`9da51d8`，2026-09-03）；B1–B4 待专项执行。实施前评审本文件。
> 目标：把 4000 行无构建前端（`workspace.js` 2688 / `app.js` 1291 / `style.css` 2272）
> 从「单文件巨型 IIFE + 顺序 script + 全局互调 + 全量 innerHTML 重渲染」迁为
> **ESM 模块化 + 局部渲染/状态流**，并保持后端 59 条 API 契约与服务行为不变。

## 一、现状与要还的债（AGENTS「已知技术债」）

1. `workspace.js` 2688 行 = 单个巨型 IIFE，79 个顶层函数/常量共享闭包；`app.js` 1291 行同构
2. `window.__ws` / `window.__app` / `window.__ui` / `window.__audio` 全局互调（optional chaining 打通）
3. 全量 innerHTML 重渲染（卡片墙/时间线/TTS 墙每次整刷）
4. `style.css` 2272 行单文件
5. 前端无自动化测试（AGENTS：人工冒烟 + e2e 仅保后端契约）

## 二、目标架构

```
public/                     # 源码（开发）
├── index.html              # vite 入口（.ts/.js 模块 + 局部样式引用）
├── modules/                # ESM 模块
│   ├── common.js           # 现有 common.js → 模块导出（$ esc fmtTime toast api …）
│   ├── state.js            # 新增：轻量状态/渲染订阅（替代全量重渲染）
│   ├── task-center/…       # 任务中心视图（由 app.js 拆出）
│   ├── workspace/…         # 创作工作台各步（文案/分镜/角色/视频/配音/渲染/BGM）
│   └── widgets/…           # 可复用组件（卡片/徽章/轮询时间线/弹窗）
├── styles/…                # 按视图拆分 css（vite 打包合并）
└── main.js                 # 入口装配：按路由/视图 mount
dist/                       # 构建产物（gitignore）
server.js                   # express.static 改指向 dist/；/api、/artifacts、/works 不变
```

关键设计：

- **模块边界代替全局互调**：视图间通过 `import` + 事件总线/轻量 store（`state.js`），删除 `window.__*`
- **局部渲染**：列表/卡片更新改「数据变更 → 更新对应子树」，不改动整页 innerHTML
- **单页入口按视图懒 mount**：任务中心与创作工作台可在同页 tab 切换，也可各留独立入口
- **构建**：devDependencies 引入 `vite`（零运行时依赖，纯构建期）；`npm run build` → `dist/`
- **零前端运行时依赖**（延续“仅 express”运行时的项目纪律）；不引入框架，用原生 DOM + 轻量订阅

## 三、里程碑（每步可独立合入、可运行、可回滚）

| M                                         | 内容                                                                                                                                                                      | 验收                                                         | 风险                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| **M4-B0** ✅ 已交付                       | 引入 vite 构建管线：`index.html` 作为入口，现有 4 个 js 原样改为模块化引用的最小改版打包到 dist；server 静态服务切到 dist（保留 /api、/artifacts、/works）；CI 增加 build | 页面与现版功能一致（人工冒烟清单），e2e 全绿，lint/format 过 | 低（行为等价搬移）                      |
| **M4-B1**（B1-1 ✅ 已交付，B1-2+ 进行中） | 建 `state.js` 订阅模型 + 把 `common.js` 正式模块化；视图逐个从 `window.__*` 改为 import                                                                                   | 无 window.__* 残留（grep 校验）                              | 中                                      |
| **M4-B2**                                 | 任务中心视图（原 app.js 1.3k 行）按文件拆（列表/看板/详情/弹窗），实现局部更新                                                                                            | 功能等价 + 冒烟                                              | 中                                      |
| **M4-B3**                                 | 创作工作台逐步拆分（六步各自模块 + 自动成片时间线 + TTS 墙 + BGM/渲染），局部更新                                                                                         | 功能等价 + 冒烟                                              | 高（2688 行闭包拆分，逐子系统人工核对） |
| **M4-B4**                                 | style.css 按视图拆分；收尾：删除 `window.__*`、旧文件；补少量前端 smoke（如 playwright/自研 DOM 冒烟，可选）                                                              | 全绿                                                         | 低                                      |

## 四、关键技术决策（实施前须冻结）

1. **构建器**：推荐 `vite`（devDep）——纯静态、无需服务端渲染；备选 `esbuild` 直出。
2. **HTML/服务**：现有 `express.static(public)` 改 `dist`；dev 期可用 `vite build --watch` 或 vite dev server 代理 /api（二选一，倾向 build+watch 以贴近生产形态）。
3. **CSS 拆分**：vite 自动合并，不用 CSS 框架。
4. **测试**：B0–B4 无前端自动化期间，维护「人工冒烟清单」（各视图 CRUD、提交/轮询、全自动成片进度、配音墙、渲染结果）。若可行补最小 DOM 冒烟。
5. **后端契约**：一律不改；e2e（mock-e2e）作为每次回归门槛。

## 五、执行要求

- 每次合入：`lint → format:check → test:unit → test:mock` 全绿 + 人工冒烟清单
- 分步 commit（refactor(frontend): …），CHANGELOG Unreleased 同步
- 迁移期间保留旧 `public/*.js` 直到 B3 完成再删（可随时回退）
