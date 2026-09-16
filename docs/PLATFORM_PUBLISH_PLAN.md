# 多平台发布包（阶段一）实施任务书

> **给新会话的开场指令**：先读 `AGENTS.md`，再读本文件与 `docs/IMPROVEMENT_BACKLOG.md` 的「P 批次：发布自动化」，
> 然后实现阶段一。**不要**在未读完 `lib/publish-kit.js` 与 `workers/render.js` 的归档段之前动手。

## 一、背景与目标（一句话）

平台已能自动产出「成片 + 发布文案 + 封面」，但**发布仍是手工**。阶段一目标：
**每集成片归档时，自动生成"多平台发布包"**——各平台规格的成片/封面/文案/字幕齐备，
用户只需"选文件 → 点发布"，**不涉及任何登录态与风控**。

## 二、已定设计（上一轮讨论结论，勿重新论证）

1. 三阶段路线：**阶段一 发布包（本次）** → 阶段二 B 站自动投递（`biliup`/接口薄封装）→ 阶段三 抖音等浏览器自动化。
2. 阶段一只做**本地物料生成**：不登录、不调平台接口、不装运行时依赖。
3. 平台差异（决定物料形状）：

| 项   | B 站                     | 抖音 / 快手                     |
| ---- | ------------------------ | ------------------------------- |
| 画幅 | 16:9（现有成片直接可用） | **9:16 竖屏**（需新出切片版本） |
| 标题 | 长标题（≤80 字，带集号） | 短、强钩子、带 `#话题`          |
| 封面 | 16:9，≥1146×717          | 竖屏封面（另做）                |
| 简介 | 长简介 + 合集归类        | 一句话 + 话题标签               |
| 字幕 | SRT 可挂                 | SRT 可挂（部分平台支持）        |

4. 竖屏做法：**模糊背景填充**（原 16:9 放大模糊作底 + 居中放置原画面），
   比"裁切"保留完整构图；顶部/底部留白区可叠集名小字（可选）。
5. 文案来源**复用现有策展文件** `tools/publish/S1EXX.json`（已含 titles/intro/tags/pinned_comment），
   为抖音类平台**新增可选字段**（如 `short_title` / `hashtags`），缺失时从 `titles[0]`/`tags` 降级推导。

## 三、交付物与验收标准

1. 作品目录新增 `发布包/`：

```
data/works/《幻灯屋 S1E04 雨の音》-44/
  发布包/
    B站/    成片.mp4 ｜ 封面.png ｜ 文案.txt（标题≤80/简介/标签/合集/置顶评论）
    抖音/   成片-竖屏.mp4 ｜ 封面-竖屏.png ｜ 文案.txt（短标题/话题/一句话简介）
    README.md   ← 各平台"上传步骤 + 该传哪个文件"的清单
```

2. 竖屏切片：`ffmpeg` 生成，**必须经 `runFfmpeg`**（`-y -nostdin` 已在其中）或独立脚本中的等价封装；
   时长与原片一致；音量/响度不得改变（只做视频滤镜）。
3. 幂等：重渲后再生成，覆盖旧发布包，不堆积。
4. **UI**：渲染面板加「📦 发布包」按钮 → 调用后端生成并提示路径（局部更新，不整页重绘）。
5. 后端新增一个路由（如 `POST /api/projects/:id/publish-package`）→ 写 openapi + e2e 用例（**契约不可变：只增不改**）。
6. 全绿：`npx prettier --check .`、`npm run lint`（0 error）、`npm run test:unit`、`npm run test:mock`、`npm run build`。

## 四、涉及文件（建议）

| 动作 | 文件                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 | `lib/publish-package.js`（纯函数：平台文案推导 + 包清单）、`tools/` 内可选 CLI                                                                                                |
| 新增 | 竖屏切片逻辑：优先抽到 `workers/render.js` 可导出函数，供渲染与手动重生成共用                                                                                                 |
| 修改 | `workers/render.js`（归档段追加发布包生成）、`routes/render.js`（新路由）、`core/openapi.js`、`test/mock-e2e.js`、`public/ws-render-panel.js` + `public/workspace.js`（按钮） |
| 修改 | `tools/publish/S1EXX.json`（新增抖音短标题/话题字段，向后兼容）                                                                                                               |
| 文档 | `docs/IMPROVEMENT_BACKLOG.md`（收口）、`CHANGELOG.md` + `package.json` 版本                                                                                                   |

## 五、硬约束（违反即返工）

- **运行时依赖仅 express**；新库一律进 `devDependencies`（本阶段建议零新依赖，ffmpeg 足够）。
- **契约零容忍**：既有 74 条路由的路径/状态码/响应结构不得变（只可新增）。
- 全仓中文注释与中文提交信息；提交前缀 `feat:/fix:/refactor:/docs:`；行长 ≤120。
- **ffmpeg 调用绝不能直接喂远端 URL**（曾致渲染死锁：`-loop 1` 每帧重下整图）——素材先落地再用。
- 单实例锁/后台 worker 生命周期操作一律经 `workers/manager.js`。

## 六、可直接复用的既有资产

- `lib/publish-kit.js`：发布文案生成（标题/简介/标签/置顶评论/看点时间轴）+ `tools/publish/*.json` 策展数据。
- `tools/card-preview.js`：单帧封面预览（复用 `titleCardFilters`）——竖屏封面可用它快速试版（`--ratio 9:16` 已支持）。
- `workers/render.js` 导出：`titleCardFilters` / `stageFont` / `findFont` / `findSerifFont` / `collectSegments` / `hasFfmpeg`。
- 作品目录既有六件套：成片 / 字幕.srt / 旁白台词.txt / 制作档案.md / 发布文案.md / 封面.png。
- 每集策展数据：`tools/publish/S1E01–E04.json`（可直接用作阶段一的输入样本）。

## 七、踩坑备忘（本仓真实踩过）

1. 远端 URL 直接喂 ffmpeg → 死锁（先落地本地）。
2. 服务重启需带 `FISH_PROXY`（否则 TTS 全 502）；重启后单实例锁约 30s 接管。
3. PowerShell 下别用 `node -e` 内嵌 ffmpeg 参数（引号被拆）——**一律写脚本文件**。
4. 生成类接口的响应体形状不保证稳定，脚本应回查项目状态而非依赖返回值。
5. e2e 会跑真实 ffmpeg 渲染（约 2–4 分钟）；触及 render/归档的改动**必须**跑 `npm run test:mock`。
6. **提交信息含双引号**（如 `"运行时依赖仅 express"`）会被 PowerShell 拆参导致 commit 失败——
   改用 `git commit -F <消息文件>`；本仓既有提交都规避了内层双引号。

---

# 阶段二：B 站自动投递（调研已完成 2026-09，路线已定）

## 八、调研结论（现状事实）

1. **官方 API 不对外开放**：B 站没有面向个人创作者的投稿开放接口（开放平台需资质与审核）。
   可行路径是「登录 Cookie + 创作中心接口」，社区已成熟。
2. **`biliup` 是当前维护中的方案**：
   - ⚠️ 旧的 `biliup/biliup-rs` 仓库**已归档**，新仓为 **`github.com/biliup/biliup`**（Rust 单文件二进制 / PyPI / 自带 WebUI:19159）。
   - 登录：扫码 / 短信 / 密码 / 浏览器 / Cookie，登录态写 `cookies.json`（用 `-u <path>` 钉死路径）。
   - 投稿参数（`biliup upload`）：`--title --desc --tag --tid --cover --copyright(1自制) --dtime(定时>4h)`
     `--line(上传线路) --limit --no-reprint --open-elec --up-selection-reply --up-close-reply --up-close-danmu --extra-fields`。
   - 支持多 P（`append`）、`show` 查状态、`list` 列已投。
   - 另有 agent 集成方式：`npx skills add biliup/biliup`（可作为未来可选）。
3. **自研接口所需的最小闭环**（若不走 biliup）：
   - 上传：`GET https://member.bilibili.com/preupload?...` → UPOS 分块 PUT → 拿 `upos_uri` 与 `biz_id`
     （`filename` = upos_uri 去后缀，`cid` = biz_id）。
   - 封面：`POST /x/vu/web/cover/up`（form: `cover=data:image/jpeg;base64,...` + `csrf`）→ 返回封面 URL。
   - 提交：`POST /x/vu/web/add/v3?csrf=<bili_jct>&ts=<ms>`，JSON body 关键字段：
     `videos[]`、`cover`、`title`(≤80)、`copyright:1`、`tid`(分区)、`tag`(≤10 个，逗号分隔)、
     `desc_format_id:9999`、`desc`(≤2000)、`recreate:-1`、`dynamic`、`no_reprint`、
     `subtitle{open,lan}`、`up_close_reply/danmu`、`web_os:3`、`is_only_self`。
   - 认证：Cookie `SESSDATA`（登录）+ `bili_jct`（CSRF）。
4. **已知风控**：`code 601 "您上传视频过快"` = 账号级临时频控（新号/低配额更易触发）→ **等几分钟重投即可，勿硬刷**。
5. **分区 `tid` 的现实约束**：Web 端已不能随意指定，需用「预测稿件类型」接口拿到的第一个固定 id。

## 九、路线选择（建议）

**默认走 biliup 外部二进制封装，同时保留降级路径**：

- 优点：成熟、维护中、自动选上传线路、扫码登录、多 P/定时齐全；**不违反本仓"运行时依赖仅 express"**
  （biliup 是独立可执行文件，非 npm 依赖）。
- 代价：用户需安装一次（Windows 直接下 Release 单 exe 放到 `tools/bin/` 或 PATH）；接口/参数随上游演进。
- **降级**：检测不到 biliup ⇒ 平台仍完成阶段一（发布包），并提示"手动上传指引 / 安装 biliup 后重试"。

## 十、与阶段一物料的参数映射

| biliup 参数     | 取自                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| 视频文件        | `发布包/B站/成片.mp4`                                                           |
| `--cover`       | `发布包/B站/封面.png`                                                           |
| `--title`       | `tools/publish/S1EXX.json` 的 `titles[0]`（默认）或用户改选                     |
| `--desc`        | 简介（各段落拼接）+ 看点时间轴                                                  |
| `--tag`         | `tags[]`（逗号分隔，≤10）                                                       |
| `--tid`         | 设置项（默认取系列模板里的分区；首次可让 biliup 用默认 171）                    |
| `--copyright 1` | 恒为自制                                                                        |
| `--dtime`       | 可选：定时发布（>4 小时）                                                       |
| 合集 / 分 P     | ⚠️ **待验证**：合集（season）与字幕投稿是否可由 biliup 覆盖，否则首版手动设一次 |

## 十一、交付物与验收标准（阶段二）

1. 设置项（`/api/settings`）：biliup 路径、cookie 文件路径、默认分区 tid、是否定时、干跑开关。
2. 新增路由 `POST /api/projects/:id/bilibili/publish`（body 可覆盖 title/tid/dtime）：
   - 前置校验：发布包存在、biliup 可用、cookie 有效（`biliup list` 探测）→ 否则返回可读错误；
   - 执行：拼装参数调用 biliup；捕获 stdout 中的 bvid；
   - **幂等**：同一渲染版本已投递过则不重复投（记录 `bvid + render_job_id`，落 settings 或新表由实现者定）；
   - 回写：bvid / 投递时间 / 状态 进任务中心或项目详情。
3. 前端：作品卡/渲染卡加「⬆️ 投递到 B 站」按钮（局部更新 + 二次确认对话框显示将要提交的标题/标签/封面）。
4. openapi + e2e 用例（**biliup 不存在时必须走"未安装"分支而非报错** —— e2e 环境天然没有 biliup，正好覆盖降级）。
5. 五项检查全绿。

## 十二、阶段三（抖音等）调研结论与建议

- **抖音**：官方上传开放平台需**企业资质 + 应用审核**，个人不可用；只能网页自动化（扫码登录、风控强、登录态需续期）。
- **小红书**：无公开发布 API，签名风控（x-s/x-t）最严，**封号风险最高——明确不建议自动化**。
- **结论**：**抖音及以下优先保持"阶段一发布包 + 手动上传"**（4 集手动上传仅数分钟，风险为零）；
  若未来要做，只做"**人工确认后触发**"的浏览器自动化（Playwright 仅进 devDependencies，且不作为无人值守流程）。
