# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [2.6.0] - 2026-09-16

### Added

- **多平台发布包（阶段一）**：每集成片归档时自动在作品目录生成 `发布包/`——把"选文件 → 点发布"所需物料
  一次备齐，**不涉及任何平台登录态与风控**：
  - `B站/`：`成片.mp4`（本项目原始画幅，直接上传）· `封面.png`（16:9 ≥1146×717）·
    `文案.txt`（标题 ≤80 字 + 备选、简介、标签 ≤10、分区/合集、置顶评论）。
  - `抖音/`：`成片-竖屏.mp4`（9:16 **模糊背景填充**切片，保完整构图不裁切）· `封面-竖屏.png` ·
    `文案.txt`（短标题 ≤30 字、`#话题`、一句话简介）。
  - `README.md`：各平台上传步骤 + 该传哪个文件的清单。
- `lib/publish-package.js`：纯函数（各平台文案推导 / 包清单 / README），策展数据缺失时自动降级
  （短标题取长标题首段、话题取 `tags` 前 5）。
- `workers/render.js` 导出 `buildPublishPackage` / `fillAspect` / `probeSize`：竖屏切片走 `runFfmpeg`
  （`-y -nostdin`），视频分支 `-c:a copy` 流拷贝 → **时长/音量/响度与成片完全一致**（只做视频滤镜）；
  画幅已一致时直接复制（零重编码）。
- `POST /api/projects/:id/publish-package`（body `{render_job_id?}`，省略取最新已完成渲染）：
  幂等整包重建（重渲后再生成不堆积），无成片/找不到成片文件 → 400，项目不存在 → 404。
- 渲染面板渲染任务行新增「📦 发布包」按钮（容器事件委托，轮询重建后仍生效）：生成后弹窗列出各平台
  文件、用途与目录路径（含降级提示），不整页重绘。
- `tools/publish/S1E01–E04.json` 新增可选字段 `short_title` / `short_intro` / `hashtags`（向后兼容，
  缺失时从 `titles[0]` / `tags` 降级推导）。
- e2e：发布包归档产物（B站/抖音 各 3 件 + README、封面画幅、竖屏时长与成片一致）+ 新路由契约
  （201 / 幂等 / 404）+ 真实 ffmpeg 竖屏切片（4:3 → 720×1280、音轨流拷贝）。

## [2.6.1] - 2026-09-17

### Added

- **即梦不可用 / 失败 → 自动回退免费档**（新增纯策略模块 `core/provider-policy.js`，
  由 `workers/submitter.js`（视频）与 `workers/image-worker.js`（图片）接线）：
  命中任一条件即**原地改投免费档（Agnes）**——只改 `tasks` 行的 `model` + `request_json` 并清掉即梦
  `submit_id`，状态回到 `queued` 交给免费路径继续，**不新增状态、不新增路由、前端列表无需改动**：
  - 环境未就绪（未装 CLI / 未登录）、**合规闸门 `need-web-confirm`**（按台账 §七「不等它」）、
    参数错、CLI 业务错（**含积分不足**）→ **立即回退**；
  - 超时 / 进程异常 → 先退避重试，**重试耗尽再回退**（避免把制作卡死在等人工上）；
  - 首帧图取不到本地文件（即梦 CLI 的 `--image` 只吃本地路径）→ 回退（Agnes 可直接引用远端 URL）。
    改投时**提示词原样保留**；时长钳到免费档 4–12s、分辨率落到 720P；首帧仅在是公网 http(s) URL 时保留
    （转 `keyframe` 模式），本地路径则降级纯文生并在任务备注写明原因。
- **`dreamina_fallback` 设置项**（默认 `'1'` = 开）：关闭后保留旧的「退避并等人工处理」行为，
  便于排查与回溯对比；`GET/PUT /api/settings` 已暴露。
- **全自动成片角色图阶段增加「提交前预检」**（`workers/auto.js`）：未安装 / 未登录 / 非 VIP / 积分不足
  → **直接走免费档**并记录原因（不再"先提交即梦、再由 worker 回退"，少绕一圈也不白占队列）；
  即梦状态带 60s 缓存，避免每轮 tick 都 spawn CLI。
- 单元测试 `test/unit/provider-fallback.test.js`（价目表分档 / 护栏回退建议 / 可用性 / 回退决策 /
  即梦→免费档映射，共 24 例）。**全部纯函数校验：不 spawn CLI、不消耗积分。**

- **分支治理规范与机械护栏**：`docs/BRANCHING.md`（分支模型 / 路径归属 / 会话纪律 / `git worktree` 并行手册 /
  `DATA_DIR` 与单实例工作锁约定）+ `tools/branch-guard.js`（按当前分支校验提交路径，越界拦截）+
  `.githooks/pre-commit`（启用：`git config core.hooksPath .githooks`）+ 单元测试。
  动机：创作与平台提交在同一支线上交织，且共享工作区里 `git add -A` 会把别人的未提交改动卷进提交。

### Changed

- **即梦价目表按模型分档**（`core/constants.js` 新增 `videoByModel`）：实测 `seedance2.0` 720p =
  **8 积分/秒**（E06 英雄镜头 10s 实扣 **80 积分**），而 `seedance2.0fast` 仍为 5 积分/秒（沿用分辨率默认档）
  —— **同一分辨率相差 60%**，此前只按分辨率取单一值会低报 60%，而该数字正是成本护栏弹给用户看的。
- **成本护栏返回「回退建议」**（`services/payloads.js`）：三档语义（`pass` / `confirm` / `block`）**保持不变**，
  以 additive 字段新增 `kind` / `free_model` / `fallback { model, reason }`；**非 VIP 账户**不再默认消费付费档。
- **前端护栏不再硬拦**（`public/task-meta.js`）：额度不足时改为明确告知"继续将自动改用免费档"，由用户决定，
  避免"以为提交了即梦、其实永远排不上"。

### Fixed

- **上游「队列满」(503) 改用分钟级耐心退避**（`workers/submitter.js`）：识别 `video_queue_full` / 503
  关键字后走独立退避档（90s 起、上限 15 分钟）——此前秒级档（10/20/40/60s）2.5 分钟即耗尽重试次数，
  等于对同一堵墙反复撞（E05 实测：修复后同一任务 1 分钟入队、4 分钟完成）。

## [2.5.4] - 2026-09-16

### Changed

- **片头卡 / 交付封面视觉重设计**：左上系列标识（宽字距）+ 集号 → 居中**挂轴纸带**内竖排**明朝/宋体**
  集名 → 底部细线 + 署名；外加细内框、背景压暗与暗角。设计取舍：细明体缺简体/假名字形（渲染成方块）
  已剔除；纯衬线在缩略图下偏弱、粗黑体缺"电影感"，最终选挂轴方案（对比最强、主题感强）。
- 新增 `tools/card-preview.js`：复用渲染同源的 `titleCardFilters()`，秒级出单帧预览（试版不必整集渲染）。
- `stageFont()` 同时置备正文（雅黑 Bold）与衬线（华文宋体/宋体，自动探测）两套字体。
- E01–E04 按新卡片重渲（`成片-107/108/109/110/111`），封面随片头卡更新；19 个历史作品目录封面同步回填。

## [2.5.3] - 2026-09-16

### Changed

- **交付封面改用片头卡帧**（用户反馈「海报不如视频封面好看」）：渲染完成后从片头卡抽一帧
  （`TITLE_DUR-1.2s`，即淡入完成后）写入作品目录 `封面.png`——自带主/副标题与署名、统一暗角，
  比原先「关键帧 + 代码绘字」的社交海报精致；同时**省掉每次渲染的一次 LLM + 文生图调用**。
- 移除 `lib/poster.js` 及其调用；`/api/works` 的封面字段（仍名为 `poster`，契约不变）改为匹配
  `封面*.png`；发布文案与作品库文案同步改为「封面」。

### Fixed

- 作品库/发布物料此前引用 `海报.png`（已不再生成）→ 现统一引用 `封面.png`；已回填 E01–E04
  与 19 个历史作品目录（从各自成片的片头卡抽帧）。

## [2.5.2] - 2026-09-16

### Added

- **开工预检 `npm run preflight`**：服务健康 / 设置完整性（含**服务进程 FISH_PROXY**，此前只有逐条配音
  502 才能发现的盲区）/ ffmpeg+ffprobe / 中文字体 / 数据目录可写 / 磁盘剩余 / **CDN 实测速率**
  （8MB、20s 预算；<200KB/s 判致命并提示开 TUN）。退出码区分致命项。
- **渲染阶段化进度**：`lib/render-stage.js` 把进度翻译成人话（准备素材 / 逐镜归一化 N/M /
  合流与混音 x% / 收尾 / 完成），API 列表与详情返回 `stage_label`，前端渲染卡展示——
  消除 E03 事故里"停在 40% 不知道在干嘛"。
- **归一化缓存**：渲染的逐镜归一化结果按「源文件身份 + 目标规格 + 配方版本」缓存到
  `data/artifacts/normcache`（12 天 TTL），重渲时未变动镜头直接复用（实测 13/13 命中）。
- **最终提交提示词可见**：`GET /api/projects/{id}/shots/{shotId}/final-prompt` 返回
  `{mode, prompt, prompt_raw, style_anchor, warnings[], refs[]}`（提交与预览共用同一组装来源），
  前端「📊 制作矩阵」新增「📋 提词」列——E03 风格漂移那类"库里的值 ≠ 发出的值"现在提交前可见。
- **图片归档补扫**：`image-worker.sweepArchives()` 为缺本地备份的项目图片补下载并回填
  `project_images.local_path`（片头卡背景与照片墙的取值来源，正是弱网死锁的根因）。
- **交付自检前端**：渲染面板「✅ 交付自检」→ 9 项 checklist 一屏（S-3 落地）。

### Fixed

- **前端 `api()` 取值 bug（3 处）**：`ws-render-panel.js` 与 `workspace.js` 误用 `.data.items`
  （`api()` 直接返回响应体）→ 渲染任务列表与多版本对比此前取不到数据。
- **片头/片尾卡署名需显式传参**：`POST /api/projects/:id/render` 未传 `creator` 时卡片无署名；
  已在制作流程固定传入，并补渲 E03（`成片-104`）。

## [2.5.0] - 2026-09-15

### Fixed

- **提示词风格锚守卫（防止风格静默漂移）**：`services/prompts.js` 新增 `ensureStyleAnchor`（幂等），
  `services/pipeline.js` 在**纯文生**与**引用角色**两条分支统一补齐项目风格锚——此前守卫只加在引用分支，
  且纯文生分支提前 `return`（空镜必中），导致手工改过的提示词丢掉风格锚后生成结果漂移成写实风格
  （E03 实拍：手部特写变成照片质感）。
- **提交器 5xx 退避重试**：`workers/submitter.js` 对 5xx（含上游队列满 `video_queue_full` 503）
  改为指数退避重试（与网络错误同档），不再秒判 `submit_error`；错误详情为空时给出可读原因
  （此前只显示"提交失败（503）："）。

- **渲染不再依赖远端素材（弱网死锁修复）**：`workers/render.js` 的 ffmpeg 调用新增硬超时（20 分钟）；
  片头/片尾卡背景图必须先落地到工作目录再交给 ffmpeg——此前 `local_path` 缺失时会把握**远端 URL 直接喂 ffmpeg**
  （`-loop 1 -i https://…`），而卡片需要 3.8s×30fps≈114 帧、**每帧重新下载一次整图**，
  弱网下渲染进度永久冻结（实测卡在 40% 达 30 分钟，ffmpeg 仅耗 2.9s CPU），且进度条无任何提示。
- **图片归档下载重试**：`workers/image-worker.js` 归档单次失败即让 `local_path` 永久为 null
  （图片侧没有视频那样的补扫兜底），改为 3 次重试 + 递增退避。

### Added

- **发布物料自动生成（B站一键复制）**：`lib/publish-kit.js` 合并「策展文案 `tools/publish/*.json`」与
  「项目 / 渲染任务 / 字幕事实」→ 作品目录下的 `发布文案-N.md`（标题候选 / 简介 / 标签 / 分区与合集 /
  置顶评论 / 看点时间轴）；渲染归档自动写入，亦可用 `POST /api/projects/{id}/publish-kit` 随时刷新
  （改文案无需重渲染）。

- **质检报告可视化告警（P1-1）**：渲染任务卡与作品详情里的质检徽章按阈值着色，超出即醒目标红黄——时长偏差 >8% 黄 / >15% 红，响度偏离 -16 LUFS >1dB 黄 / >2dB 红；`🔍 质检` 汇总徽章同步按最严重项着色。新增纯函数 `public/ws-render.js` `qualityFlags`，渲染任务卡与 `works-panel.js` 作品详情复用同一套阈值（`.meta-tag.warn`/`.meta-tag.bad`）。
- **全自动等待时间预估（P1-2）**：全自动时间线在「等待视频完成」阶段显示「预计还需约 X 分钟 · 提交限流 1 次/分钟，剩 N 镜未完成」——`workers/auto.js` 每轮把剩余镜数与 ETA（纯函数 `estimateWaitMinutes`，按 `submit_interval_ms` 逐镜累加、未限流按每镜 0.5 分钟兜底）写入 `auto_state.wait_videos`，前端 `ws-render.js` 时间线展示（`.at-wait`）。单测 84 → 89。
- **机械性 high 自审问题自动修复（P1-4）**：全自动管道里 L1 自审对「角色镜头漏注入 `<Picture 1>` 前缀」这类**确定性缺陷**不再只提示、直接自动修复（按当前提示词幂等补前缀，不采信 LLM 改写以防主观漂移）；主观性 high（叙事/节奏/画面取舍）仍留人工确认。新增纯函数 `services/prompts.js` `ensureCharacterRefPrefix`/`isMechanicalPromptFix`，`services/pipeline.js` 提交路径复用同一前缀来源（消除硬编码漂移）；单测 89 → 97。
- **L1 审查「采纳全部非 high」（P1-3）**：手动审查报告窗新增一键按钮，批量采纳全部 medium/low 修订（对齐全自动管道既有行为），高优先级硬伤仍逐条确认；采纳逻辑抽为共享 `adoptOne`（逐条/批量同源），批量过程显示进度、结束汇总「已采纳/找不到镜头/失败」并只触发一次项目刷新。仅当存在非 high 项时显示按钮。
- **旁白编辑→重渲快捷链路（P2-5）**：分镜卡在有旁白文案时新增「🎙️🎬 配音并重渲」按钮——一键完成「用本镜最新旁白重新配音 → 立即提交一版成片渲染」，免去手动走第⑤步配音 + 第⑦步渲染两步（确认后后台执行）。渲染提交逻辑抽为 `ws-render-panel.js` `submitRender`（渲染按钮与快捷链路共用），沿用局部更新（新任务行插入 + 续轮询）。
- **成片多版本对比视图（P2-6）**：第⑦步新增「⚖️ 多版本对比」按钮——拉取同项目全部已完成成片，弹窗并排播放（最新在左，各自标注时长/响度/偏差徽章与下载），支持「▶ 同步播放」（各版从同一起点播放并自动对齐进度）/「⏸ 全部暂停」，便于发现剪辑节奏、配音与时长差异；不足 2 版时提示。
- **成功案例参数模板化（P2-7）**：新增「创作模板」——把「创意写法 + 风格 + 画幅/时长 + 成片预设配方」存成可复用模板。渲染面板「💾 存为创作模板」保存当前项目参数；新建项目弹窗「📋 套用创作模板」一键回填（含成片预设卡片自动选中）并可删除。存储用 `settings.creation_templates`（JSON KV，与 `tts_voice_pool` 同款，**零新表**）；新增 `GET/POST/DELETE /api/templates`（`routes/templates.js`，名称必填、上限 50 条）；openapi/AGENTS/README 同步（路由域 9 → 10、契约 59 → 62 条），e2e 新增模板 CRUD 用例（新建/字段校验/空名 400/列表/删除/重复删 404）。
- **字幕/配音解耦 + 双语硬字幕**：渲染字幕文本改为优先取「镜头旁白脚本」（`shot.narration`），配音文本与之不同时**自动输出双语两行**（脚本在上、配音在下）——由此支持「外语配音 + 本地语言（+外语）硬字幕」（实测：赛璐璐短片用日文配音 + 中/日双语硬字幕）。字幕纯函数（`services/subtitles.js`）支持文本内 `\n` 硬换行（ASS/SRT 均保留多行），单测同步。
- **片头/片尾卡主题化 + 署名（`creator`/`title`/`subtitle` 渲染参数）**：片头卡改为「项目场景图主题画面（压暗 + 暗角）+ 主标题 + 副标题 + 署名」，片尾卡场景图压暗 +「— 完 —」+ 片名 + 署名；无场景图时退回暖褐渐变底、字体缺失降级为纯背景（保持既有兜底链）。主/副标题未显式传参时按项目名首个空格拆分（`幻灯屋 S1E01 灯を点す` → 主「幻灯屋」/ 副「S1E01 灯を点す」）；片头卡时长 2.8s → 3.8s（容纳三行文字）。`core/config.js`/`routes/render.js`/`workers/render.js`/`core/openapi.js` 同步，单测 +1 契约字段。

### Fixed

- **e2e 海报生成告警澄清（mock 缺陷，非产品 bug）**：mock 的 `/out/` 前缀分支对图片 URL（`img-mock-*.png`）也返回视频 fixture（MP4），海报底图实际下到多帧视频，drawtext 合成把多帧写单个 PNG 触发 image2「Cannot write more than one file」warn（首帧仍落盘，故 e2e 误显「海报 ✓」）。为 `.png` 路径补充真实 PNG fixture（ffmpeg 单帧生成），海报链路 e2e 干净通过（warning 清零）。生产 `generateImage` 返回真实图片 URL，无此问题。
- **声音广场（`listWebModels`）在代理环境不可用**：原实现用 Node 原生 `fetch`（不走 `FISH_PROXY` 隧道），配了代理的机器上必 `fetch failed`（与早前 TTS 代理问题同源）。改为走隧道（新增通用 `requestJson`：CONNECT + TLS + `createConnection`，注意不传 `agent:false`），实测 `/api/tts/market` 恢复正常。
- **成片尾部静音（BGM 未铺满全片）**：`sidechaincompress`（旁白闪避）的**输出长度随侧链结束而截断**——最后一条旁白之后的 BGM 段整段丢失（实测：137.7s 成片音频流仅 128.4s ≈ 最后一句旁白结束点，尾部 9.3s 无 BGM，用户可听出"BGM 差几秒没到结尾"）。修复：闪避侧链 `apad=whole_dur=<片长>` 补静音至片长后再入 sidechaincompress，输出链尾再加 `apad` 兜底（覆盖无闪避/单旁白等其余短音频路径）。重渲验证：音频流 137.68s ≈ 视频流 137.70s。
- **BGM 开头爆音（听感"咯噔"）**：部分音源文件开头有孤立强瞬态（实测 E02 用的《阴雨天》在 0.25/0.5/0.75s 处为 -0.2/-1.9/-13.9 dB，非音乐内容，成片开头可清晰听到），另有音源开头带静音 padding（E01《承诺》前 1s 为 -91dB）。新增渲染参数 `bgm_start_ms`（0–10000，默认 0）跳过音源开头；E01/E02 均以 1000ms 重渲，开头恢复平滑淡入、无突兀脉冲。
- **镜头原声（AI 环境声）低音量混入（新增 `ambient_volume` 参数）**：镜头视频自带 AI 生成的环境声（雨声/海浪/放映机声等），此前渲染一律 `-an` 剥离（成片仅「旁白 + BGM」两层）。现支持按"镜头起幅点"对齐后低音量混入：归一化改为保留音轨（`-map 0:v:0 -map 0:a:0?`，无音轨素材不报错），终混重构为「旁白 / BGM / 环境声各自成形后统一 amix」（环境声不参与闪避侧链）。`ambient_volume` 0–1，默认 0 = 沿用剥离行为（向后兼容）；实测 E02 对比版（0.25）：片头卡两版样本差 0（无镜头原声的对照区），镜7 雨巷差异显著（雨声混入），loudnorm 保持总响度一致。
- **多角色引用（`ref_image_ids` / 多张角色定稿图 / `append`）**：按官方口径，Agnes Video 2.5 Flash 的 `reference` 模式最多支持 **5 张参考图**（`audios` ≤3、`videos` 不支持）。据此把"一个项目只能锚一张角色图"升级为**多角色**：`select-image` 新增 `append:true`（追加定稿，默认仍替换，向后兼容）与 `selected:false`（取消定稿）；镜头新增 `ref_image_ids`（本镜出场角色图 id ≤5，省略=全部定稿角色图）；`pipeline` 按镜头选角色注入多图，提示词前缀自动并列编号（`以 <Picture 1>、<Picture 2> 中的角色为参考…`；已含 `<Picture N>` 幂等不改写，精确指代由分镜提示词书写）；挂项目图片任务的"首张自动定稿"改为**仅当该 kind 尚无定稿时**（避免历史定稿图累积注入）。数据层新增 `shots.ref_image_ids` 迁移、`projects.selectedImages()`、`imageRowToApi` 统一映射；openapi / e2e（新增多角色用例）/ 单测（99）同步。实测：镜12 绑两张参考图生成「風花＋修鞋匠」同框，两人形象与各自种子图一致。
- **角色库（跨项目角色资产）+ 分镜批量导入（P0-2 / P1-1）**：**角色库**存于 `settings.character_library`（KV，零新表）——从项目角色图「⭐ 收藏」（`POST /api/characters`，记 名/图/提示词/服色锚/所属系列）、列表、删除（`/api/characters/:id`）、**导入项目**（`POST /api/projects/:id/characters/import`，≤5 个，复制为 `project_images` 并追加定稿）；**分镜批量导入** `POST /api/projects/:id/shots/bulk`（`append|replace`，事务一次建齐 N 镜，服务端一次性校验：video_prompt 非空 / seconds 4–12 / 旁白 ≤ 秒数×4 / `ref_image_ids` 必须是本项目定稿角色图 / 总数 ≤20）；**创作模板扩展为系列模板**（新增 `character_ids`/`voice`/`bgm_song_id`/`naming`）。前端：通用弹窗 `openModal`（common.js）、角色区「📚 从角色库导入」、图墙「⭐ 收藏」、分镜区「📥 批量导入分镜」。constants 新增 `MAX_CHARACTERS`/`MAX_BULK_SHOTS`；openapi/server 注册同步；e2e 新增用例全通过。
- **渲染质检面板 + 客观视频指标（P2-1 / P2-2）**：新增 `GET /api/render/jobs/{id}/inspect`（按需生成并缓存）——**关键帧 4 张**（6%/34%/64%/92% 处）+ **音频波形图**（一眼看出开头爆音/尾部静音）+ **音视频流时长对比**（`audio_gap_s > 0.5` 提示尾部静音）+ **客观指标**（`luma_mean` 平均亮度 / `luma_std` 亮度波动 / `flash_ratio` 闪烁帧占比 / `motion_mean` 帧间差即运动幅度，供 AI 与人工筛查可疑镜头/镜头）+ `hints` 自动告警。前端渲染任务卡新增「🔍 质检图与指标」弹窗。实测：E02 成片 22s 出结果，流差 0、亮度波动 16.9、闪烁 0。
- **镜头级客观指标（P2-2）**：指标计算抽为 `lib/video-metrics.js`（渲染质检与镜头筛查共用），新增 `GET /api/tasks/{id}/metrics`——对单条已完成任务的视频计算 亮度均值/波动、闪烁帧占比、帧间差（运动幅度），供 AI 与人工优先复核可疑镜头。实测 E02 镜4（静镜）18s 出结果（亮度 86.1 / 波动 0.3 / 闪烁 0 / 运动 0.6）。
- **P3 细节补齐**：`ambient_volume` 默认 0 → **0.2**；新增 **`PATCH /api/tts/{id} {offset_ms}`**（逐镜配音偏移 0–3000/null，此前只能直改库）并**修复既有 bug**（tts 行映射漏 `offset_ms`，导致渲染侧恒用全局偏移）；新增 `estimateJaMoras`/`hasKana`（日文音拍估算，TTS 长度校验对日文改走「音拍 ≤ 秒数×7」口径）；角色库导入前**探测图 URL 可达性**（不可达则跳过并在 `skipped` 回报）。

## [2.3.0] - 2026-09-09

### Added

- **视频归档改可配置（`video_auto_download` 开关，默认关闭）**：默认仅保留平台链接（省磁盘，链接可能过期）；开启后在任务完成/历史补扫时把视频下载到本地，下载失败自动重试 3 次、手动查询可补归档、启动补扫受开关控制；设置面板提供开关，README/e2e 同步。
- **看板列内分页**：每列默认展示 5 条、列脚迷你分页器（一次拉取前列缓存、超过 500 条暂按最近窗口）；任务中心行内与详情「立即查询」按任务状态分流提示（失败不再弹绿勾）、详情打开先显示加载占位；新增全局 `.btn` 禁用态样式。
- **工作台草稿保护**：整页重绘不再丢弃未保存输入——表单编辑标脏 + 渲染前快照/完成后回填（renderProject 包一层 wrapper，覆盖分镜/角色/自由文稿/文案分区等编辑区）；新建项目创建在途时关闭弹窗=取消创建（自动删除空项目并刷新列表，不再被强拉进新项目）。

### Changed

- **图片模型升级至最新免费 `agnes-image-2.5-flash`**（替代 2.1-flash；参数与 2.1 完全同构，仅换模型 ID，同步单测断言）。
- **dev 脚本改用 `node --watch server.js`**：后端改动保存即自动重启（`start` 不变；前端源码经 public 直载，刷新即最新）。
- 校准 `agnes-video-v2.0` 元数据措辞为「官方在售 · UI 不主推 · API 兼容保留」（constants 元数据 + 前端显示名 + README/规划文档）。

### Fixed

- **上游错误按语义分类并去 raw**：429 限流/401·403 鉴权不再误映射为 400；错误文案不再直贴上游 raw；请求体超限返 413；TTS 非法音色/模型与镜头旁白超长、渲染参数越界均直接 400 提示而非静默回退/钳制。
- **自动成片预检 ffmpeg 与 API Key**：不再卡「等待渲染完成」/假启动反复重试；渲染器遇 ffmpeg 不可用把排队任务标失败而非静默空转；worker 失败消息改中文语义提示（ffmpeg/上游 raw 原文只进日志）。
- **前端表单交互与反馈细节**：新建任务打开即统一重置并本地校验（空 prompt/首尾帧双空/参考无素材），设置保存加 busy 态与语速越界拦截，AI 优化回填 trim，配音按钮失败还原原文案，批量提交手动停止用警示色，AI 回填/对比展示不再带首尾空行；全站弹窗支持 Esc 关闭。
- 清理 `#btnClearDone` 死代码处理器（按钮已随归档开关改动从 HTML 移除，遗留绑定会在 init 时抛 TypeError）。

### Refactored

- **M4-B4：`style.css`（2341 行）按视图拆分为 `public/styles/` 六文件，M4 前端重构专项收官**——base（变量/reset/顶栏/按钮/弹窗/表单/日志/Toast/空状态/导航 tabs）/ task-center（工具栏/视图切换/时间线/分页/看板/卡片/详情弹窗）/ new-task（类型 Tab/图片产物墙）/ workspace（分镜卡片/对比弹窗/步骤引导/风格预设/高级配置/全自动时间线/主体布局）/ works（作品库卡片墙）/ theme-light（浅色主题覆盖）。**逐行原样搬运零行为变化**（脚本校验 27 段内容逐行一致）；**层叠安全**：拆分前解析全部 387 条规则，确认同选择器跨文件相对顺序零翻转，theme-light 保持在加载顺序末尾；`index.html` 改为按序六个 `<link>`（顺序敏感：base 在前、theme-light 最后），vite 构建合并为单产物（构建产物中顺序复核通过），未构建时 public 回退直载同样成立。顺带补齐上个提交遗留的 5 文件 prettier 格式漂移（README×2/routes×2/workers×1，纯换行）。`lint`（0 errors）/ `format:check` / `build` / 84 单测 / e2e（含静态首页）全绿。

- **M4-B3-7：renderProject 内联绑定清空——第⑥步 BGM 面板拆出 `public/ws-bgm.js`、第⑦步成片渲染面板拆出 `public/ws-render-panel.js`（workspace.js → 约 880 行，仅剩装配与步骤导航）**——渲染按钮提交 / 成片风格预设套用 / 高级配置实时配方说明 / 渲染任务轮询迁入 ws-render-panel（startRenderPoll 随迁，renderJobItem 常量复用 ws-render）；BGM 在线搜索/试听/选用/清除迁入 ws-bgm（bgmCurrentHtml/fmtSecs/precheckHtmlFromDetail 复用 ws-render）。**交互改「局部更新」**：渲染提交成功只在 `#wsRenderJobs` 顶部插入新任务行并续轮询、轮询只增改该子树且全部落定即停（不再整页重绘 → 保留面板已调配置与其作步骤未保存输入）；BGM 选用/清除后只刷 `#wsBgmCurrent` 与步骤⑥圆点与 `#wsPrecheck`（ws-render 新增纯函数 `precheckHtmlFromDetail`，refreshTasks 一并复用，统计口径不变）。行为等价，`lint`（0 errors）/ `format:check` / `build` / 84 单测全绿。M4-B3 六步模块拆分至此全部交付，剩 CSS 拆分/收尾（B4）。

- **netmusic 客户端解耦数据层**：`clients/netmusic.js` 不再 require db —— 改为依赖注入工厂 `createNetmusicClient(settings)`，由装配方接线（routes/music、routes/settings 只取静态 `LEVELS`，workers/auto、workers/render 注入 settings 后使用）；消除客户端↔数据层耦合，行为不变（e2e BGM 搜索/试听/选用/渲染流全绿）。
- **M4-B0：前端构建管线（vite）**——引入 `vite`（devDep）与 `vite.config.mjs`（root=public → `dist/`，已 gitignore）；`public/index.html` 改为 ESM 入口 `main.js`（顺序 import common/compare/app/workspace，行为等价阶段）；`server.js` 静态服务 dist 优先、public 回退（未构建时原生 ESM 源码可直接调试）；eslint/prettier 适配 `.mjs`/`dist` ignore，CI 增加 `npm run build`。`lint` / `format:check` / 单测 / e2e（含静态首页）全绿。后续 B1–B4 见 `docs/FRONTEND_REFACTOR_PLAN.md`。
- **M4-B1-1：`public/common.js` 正式 ESM 模块化**——由「IIFE + 挂 `window.__common`」改为标准 ES module（顶层 `export { $, $$, esc, fmtTime, toast, api, theme }`），保留 `window.__common` 兼容注入供仍为 IIFE 的 compare/app/workspace 在 evaluate 阶段解构（main.js 顺序 import 保证注入先于其求值）；eslint 增加 common.js module 专项块。行为不变，`lint` / `format:check` / `build` / 单测 / e2e 全绿。B1 后续见蓝图。
- **M4-B1-2：compare/app/workspace 显式 import common**——三文件改为 `import { … } from './common.js'`（转 ES module，内部仍为 IIFE），删除各自 `window.__common` 解构；`window.__common` 兼容注入暂留待删。行为不变，`lint` / `format:check` / `build` / 单测 / e2e 全绿。
- **M4-B1-3：`state.js` 事件总线 + workspace→app 任务信号去互调**——新增 `public/state.js`（on/off/emit，监听器异常隔离）；workspace 原 4 处 `window.__app?.loadTasks?.()`（单镜提交/重拍/批量结束/切任务中心后刷新）改为 `bus.emit('tasks-changed')`，app 订阅该事件刷新任务中心（不切视图，语义等价）；剩余互调（app→ws refresh、读 app.getSettings）留待 B1-4。`lint` / `format:check` / `build` / 单测 / e2e 全绿。
- **M4-B1-4：app↔workspace 互调清零**——app 轮询喂工作台进度 `window.__ws?.refreshTasks?.()` → `bus.emit('ws-task-progress')`；切创作工作台视图 `window.__ws?.refresh?.()` → `bus.emit('workspace-shown')`（10s 节流留在 app 轮询）；workspace 批量提交读提交间隔改为直接 `GET /api/settings`。`window.__app/__ws` 已无跨视图消费者（仅剩各自模块导出赋值，B4 统一删除）。`lint` / `format:check` / `build` / 单测 / e2e 全绿。
- **M4-B1 收尾：移除 `window.__app`/`window.__ws` 导出**——视图互调已全部事件化/直接取数，两处模块导出已无消费者，予以删除（`applyTemplate`/`loadTasks`/`refresh`/`refreshTasks` 仍在各自作用域内部使用）。`window.*` 现仅剩共享组件 `window.__ui`（compare）与 `window.__audio`（B2 处理）。`lint` / `format:check` / `build` / 单测 / e2e 全绿。
- **M4-B2-0：`window.__*` 代码清零**——compare 组件 ESM 化（`export { compare }`，app/workspace 显式 import）；common.js 删除 `window.__common` 兼容注入；workspace 删除恒 false 的 `window.__audio` 死分支。至此 `public/` 下无任何 `window.__*` 代码引用（仅注释说明），视图间通信全部经 `state.js` 总线。`lint` / `format:check` / `build` / 单测 / e2e 全绿。B2 视图拆分（app/workspace 内部结构）进行中。
- **M4-B2-1：任务中心视图按文件拆分（app.js 1409 行 → 装配层约 160 行）**——按视图域拆出 5 个 ESM 模块：`task-meta.js`（/api/meta 模型元数据 + 表单下拉填充）、`settings-panel.js`（设置弹窗 + 顶栏连接状态渲染）、`new-task.js`（新建任务表单/模板/AI 优化/参考素材）、`works-panel.js`（作品库与详情弹窗）、`task-center.js`（列表/看板/详情/统计/分页/视频懒加载，沿用集合签名局部更新防打断播放）；`app.js` 瘦身为装配层（主视图切换/2s 轮询/日志/弹窗通用关闭/模块初始化编排）。任务提交/删除等「数据已变更」信号统一走 `bus.emit('tasks-changed')`（此前新建任务直接调 loadTasks）。顺带修复 M4-B1 收尾遗留：`index.html` 视频模板下拉的 `onchange="window.__app?.applyTemplate(...)"` inline 引用（`window.__app` 已删 → 模板选择失效）改由 new-task.js 内 `change` 监听绑定；eslint 合并 public ESM 块（全仓统一 module，删遗留 `__*` globals）。行为等价，`lint` / `format:check` / `build` / 84 单测 / e2e（含静态首页）全绿。workspace 拆分待 B3。
- **M4-B3-1：创作工作台「渲染层」拆出 `public/ws-render.js`（workspace.js 2826 → 约 2100 行）**——把全部**纯常量 + 渲染 HTML 纯函数**（AUTO 时间线 / 新手引导 / 步骤导航 / 项目卡 / 分镜区 renderStoryboardArea / 文案分区 / 镜头提交块 / TTS 墙 / 预检 / 任务列表 / 渲染面板 / 声音占位等，共 21 个导出 + 内部自洽常量）迁入独立 ESM 模块，与状态/事件解耦：数据一律经参数传入，唯一外部依赖为 common 的 `esc/fmtTime`；两个原本读闭包状态的函数参数化（`renderShotSubmitBlock(…, batchBusy, batchHint)`、`stepGuideHTML(n, showGuide)`）；`shotLatestTask` 随迁导出供批量提交复用。workspace.js 保留全部会话状态 / renderProject 装配 / 事件绑定 / 动作与轮询，改 import 使用渲染层。行为等价，`lint` / `format:check` / `build` / 84 单测 / e2e 全绿。为 B3 后续「按步骤把动作/事件拆成模块」铺好共享渲染底座。
- **M4-B3-2：工作台第⑤步「配音 + 声音广场」拆出 `public/ws-tts.js`（workspace.js → 约 1780 行）**——TTS 全动作（自由文稿/逐镜/批量配音、TTS 墙绑定/选用/删除/试听、音色偏好缓存 wsDefaultSpeed/defaultTtsText）与声音广场（备选池 refreshVoicePool + bindVoiceMarket）迁入独立 ESM 模块，仅依赖 common/state；删除 loadMetaVoices 内死代码 `let meta = META;`（lint -1，基线 10→9 warning）。**动作后「整页重刷」改用 bus 解耦**：子模块广播 `bus.emit('ws-project-changed', projectId)`，装配层（workspace.js）订阅并判断「当前项目 === pid」再 `renderProject`——消除子模块对装配的硬依赖，杜绝 import 环（沿用 B1-4 tasks-changed 同款模式）。行为等价，`lint` / `format:check` / `build` / 84 单测 / e2e 全绿。剩余步骤（分镜/角色/视频/渲染/文案动作与 renderProject 内联绑定）待 B3-3…
- **M4-B3-3：会话状态抽至 `public/ws-state.js`（`st` 可变单例）**——workspace IIFE 内 11 项顶层会话状态（currentProjectId / script·story·img busy / currentShotCount / projectsShotsCache / batchBusy·Stop·Hint / currentStep / wsFilmPresetId）迁入独立模块导出对象，全部 ~80 处引用改 `st.xxx`（词界受控替换 + 删除原声明行，无对象简写/字符串误伤）。至此后续分镜/角色/视频/渲染「动作+事件」拆成独立模块时可跨文件共享会话状态（动作完成重刷已走 bus，B3-2）。行为等价，`lint` / `format:check` / `build` / 84 单测 / e2e 全绿。剩余 renderProject 内联绑定与各步骤动作拆模块待 B3-4…
- **M4-B3-4：通用工具 + 第④步「视频提交」动作拆出（workspace.js → 约 1630 行）**——新增 `public/ws-util.js`（sleep / stageHints / STAGES_SCRIPT·STORY·IMG，供各步骤动作复用）与 `public/ws-video.js`（单镜 submitShot / 批量 runBatchSubmit / 旧单任务 submitVideo）；批量提交读 `st.batchBusy/Stop/Hint`，动作后整页重刷（含批量开始时切换「批量提交中…」UI）统一走 `bus.emit('ws-project-changed', projectId)` 由装配层调度；runBatchSubmit 节流等待用 ws-util 的 sleep、镜头筛选用 ws-render 的 shotLatestTask。行为等价，`lint` / `format:check` / `build` / 84 单测 / e2e 全绿。剩余第②③⑥⑦步动作/绑定与 renderProject 内联绑定待 B3-5…
- **M4-B3-5：第③步「角色设定图」拆出 `public/ws-char.js`（workspace.js → 约 1520 行）**——角色描述 AI 优化 optimizeCharDesc（改无参签名，原 projectId 实参未用）、生成角色图 genCharacterImage（含 CHAR_OPTIMIZE_PROMPT；busy 走 `st.imgGenBusy`、开始/结束整页重刷走 bus `ws-project-changed`，加载文案由重绘后出现的 .ws-loading-text 承接）、图墙定稿/删除 bindWallEvents。lint 基线 9→8 warning。行为等价，`lint` / `format:check` / `build` / 84 单测 / e2e 全绿。剩余第②文案/分镜动作与 renderProject 内联绑定（BGM/渲染面板）待 B3-6…
- **M4-B3-6：第②步「文案与分镜」拆出 `public/ws-story.js`（workspace.js → 约 1100 行）**——生成/重新生成文案 genScript（含 SCRIPT_FIELDS 导出，装配层 guideInfo 用）、分镜生成 genStoryboard / AI 自审 reviewStoryboard / 升级分镜 promoteToStoryboard / 镜头排序 moveShot / 分镜编辑保存·单镜配音按钮·历史版本选用 bindStoryboardEvents（含 bindNarrMeters）/ 文案版本保存与选用 bindTextSectionEvents，全部动作后整页重刷改走 bus `ws-project-changed`；SEV/FIELD_LABEL 随迁。workspace 保留 renderProject/renderList/openNewProject、refreshTasks、startRenderPoll、bindGotoTaskLinks 及剩余内联（BGM/渲染面板）。lint 保持 8 warning。行为等价，`lint` / `format:check` / `build` / 84 单测 / e2e 全绿。剩余 renderProject 内联绑定（BGM 搜索选用/渲染按钮/风格预设/高级配置）待 B3-7…

## [2.2.2] - 2026-09-03

### Refactored

- **服务端模块目录归位（纯物理移动，零行为变化）**：根目录平铺的模块按职责收进语义子目录 —— `core/`（constants/config/errors/logger/openapi）、`clients/`（agnes/fish-tts/netmusic）、`workers/`（submitter/poller/image-worker/render/auto）、`lib/`（artifacts/poster），`pipeline.js` 移入 `services/`；全量相对 require 修正。`lint` / `format:check` / 74 单测 / 72 e2e 全绿，59 条 API 契约、`npm start` 运行方式与 `data/` 结构均不变。
- **M2 分层纪律收拢（零行为变化）**：① 任务入队从 `services/payloads.js` 拆出为 `services/task-queue.js` —— payloads 恢复纯校验/组装、不再依赖提交器；② 新增 `workers/manager.js` 统一启停 5 个后台 worker，并把「轮询间隔重载 / 重试唤醒 / 手动轮询」的驱动向路由收敛（routes/settings、routes/tasks 不再直接 require poller/submitter/image-worker 实例）；③ 字幕纯函数（ASS/SRT）迁至 `services/subtitles.js`，`workers/render.js` 净减约 200 行、仅保留 ffmpeg 编排与归档。`lint` / `format:check` / 单测 / e2e 全绿，59 条 API 契约与运行方式不变。
- **M3 数据层收尾（一）**：① superseded 展示标注上移出数据层 —— `db.js` 的 `projects.tasks()` 恢复纯查询，该规则由 API 聚合层 `routes/projects.js` 的 `annotateSuperseded` 标注（e2e 项目详情契约不变）；② 单实例工作锁自 `db.js` 拆出为根模块 `instance-lock.js`（原子 CAS 语句随迁，server 与 5 个 worker 改从其引用），`db.js` 不再导出锁。`lint` / `format:check` / 单测 / e2e 全绿。
- **M3 数据层收尾（二）：`db.js` 目录化 + repos 表族拆分** —— 1224 行单文件拆为 `db/` 目录：`kernel.js`（连接/PRAGMA/schema DDL/自动迁移/parseJson/tx，数据目录默认路径修正为仓库根 `data/`）· `sql.js`（全部 prepare 语句单一注册表）· `repos/{settings,tasks,projects,renders}.js`（表族仓库，projects 含 texts/images/shots/tts 子域，`db/index.js` 组合出口保持 `{ db, settings, tasks, projects, renders, tx, DEFAULT_SETTINGS, DB_PATH, DATA_DIR }` 导出契约）。19 处 `require('./db')` 与 `instance-lock.js` 零改动（Node 目录 index 解析）。`lint` / `format:check` / 84 单测 / 72 e2e 全绿。

## [2.2.1] - 2026-09-02

### Added

- **作品库页面「🏆 我的作品」**：顶部导航新增第三视图——成品直接在网页展示，不必去本地目录翻找。海报封面卡片墙（多版成片数 / 镜数 / 旁白覆盖 / 时长角标 / 渲染日期），点击卡片开详情弹窗：内嵌播放器（最新成片）+ 全套下载（各版成片 / 海报 / SRT 字幕 / 旁白台词）+ 质检徽章 + 一键复制作品目录路径。
- `GET /api/works`：实时扫描 `data/works/` 汇总全部作品（项目已删除仍展示——目录名解析项目 ID，作品名回退目录名；质检报告从渲染任务回查，任务已删则仅缺质检不影响展示）。

## [2.2.0] - 2026-09-02

### Added

- **作品归档目录 `data/works/`**：渲染完成的成品不再与中间素材混放——每部作品独立目录 `data/works/《作品名》-项目ID/`，内含：
  - `成片-<渲染任务ID>.mp4`（同项目多次渲染按任务版本共存）
  - `字幕-<渲染任务ID>.srt`（SRT 通用格式，时间轴与成片对齐，带 UTF-8 BOM 兼容 Windows 记事本；无旁白影片落占位说明）
  - `旁白台词.txt`（项目级最新版：镜头序号 + 标题 + 台词全文）
  - `海报.png`（见下）
- **社交平台海报自动生成**：渲染完成后自动生成一张可直发的海报——LLM 基于创意/风格/梗概产出「电影海报级」文生图提示词（单一主视觉、戏剧化光线、预留标题区、画面无文字）→ agnes-image 出 2K 底图（画幅跟随项目：竖屏项目出竖版海报）→ ffmpeg 叠项目名大标题（半透明衬底 + 描边，任何画面可读）。全程 best-effort 异步执行，失败仅记 warn 绝不阻塞成片。
- `render_jobs` 新增 `work_dir` 列；渲染任务响应携带 `work_dir` / `work_url`；前端渲染卡展示「📁 作品已归档」路径行；新增 `/works` 静态服务。
- 删除渲染任务**不再**清理作品目录（作品是用户劳动成果，仅清 artifacts 中的渲染缓存副本）；删除项目同样保留作品目录。

### 测试

- 单测 80 → 84 项（buildSrt 纯函数：SRT 结构/时间格式/无效行过滤/空输入）；e2e 渲染用例新增作品归档断言（目录命名/成片/字幕/台词四文件 + 海报轮询 best-effort）。

## [2.1.0] - 2026-09-02

《末班车》复盘 P0 三项落地（docs/CREATION_PLAYBOOK.md 建议清单）。

### Added

- **全自动管道自动选配乐（bgm 阶段）**：`auto.js` 在配音与渲染之间插入 BGM 阶段——按项目风格关键词自动选曲（治愈→钢琴 / 热血→摇滚 / 悬疑→氛围弦乐 / 国风→古筝 / 童话→八音盒 / 赛博→电子 / 纪录→轻音乐，映射表 `STYLE_BGM_KEYWORDS` 进 constants），**未命中风格默认「轻音乐」**（内容创作类视频纯轻音乐最稳：不抢观众注意力、衬托旁白）；取搜索首个结果下载缓存并落库，时间线新增「配乐」节点。降级策略：已选 BGM 跳过 / 音乐接口未配置记建议后继续 / 搜索空或下载失败 warn 跳过——**成片永不因配乐阻塞**。全自动成片从「必然无配乐」变为「默认带纯音乐」。
- **旁白字数即时计量条**：镜头卡旁白编辑框下方实时显示 `X/Y 字 · 配音 ≈Zs / 镜头 Ns`（语速按实测标定 4.6 字/秒），超限变红并提示「渲染时将被截断」；旁白输入与镜头时长下拉联动刷新。把 v2.0.3 的后端硬限规则前移到编辑时即时可见。
- **渲染前预检面板**：渲染按钮上方四枚三态 chips——镜头就绪（≥2 完成镜头）/ 旁白匹配（逐镜「配音时长+0.5s ≤ 镜头时长×1.035」）/ 配乐状态（已选绿 · 有旁白无 BGM 黄 · 全无黄且提示无声）/ 预计时长（信息性）。挂入 10s 项目轮询，视频后台完成时预检自动转绿；渲染前一眼看清风险，不再渲完才发现问题。

### 测试

- e2e：全自动闭环新增 bgm 阶段断言（阶段序列含 bgm、自动选中《测试曲》、选曲说明落历史）。

## [2.0.3] - 2026-09-02

《末班车》实拍复盘（v2.0 全自动从 0 到 1 实测）暴露的旁白链路缺陷修复。

### Fixed

- **旁白超长被镜头时长截断（高，实测发现）**：分镜提示词允许旁白 15~~40 字，但 TTS 实测约 4.9 字/秒（含标点停顿）——5 秒镜头配 38 字旁白时配音 7.8s，渲染对齐时尾部被压掉 30~~44%，听感为每句说一半戛然而止。三层修复：①分镜/审查系统提示词改为「旁白字数 ≤ seconds × 4（含标点）」并把该维度加入 L1 审查（超长必须给压缩修订）；②`clampNarration` 纯函数硬兜底——`normalizeStoryboardShots` 按每镜秒数限长（超长优先在句读处截断，至少保留 8 字），L1 审查的旁白修订同样限长（12s×4=48 字上限）；③实拍项目以「精修旁白 → 逐镜重新配音 → 重渲」验证：6 镜配音全部 3.7~4.2s（+0.5s 偏移 < 5.2s 镜头），零截断。
- **全自动时间线文案失真（低）**：`auto.js doCharacter` 的「已定稿跳过生成」分支先于在途任务分支执行——流水线自己生成的角色图完成定稿后，历史误记为「跳过生成」。调整为在途任务分支优先。

### 测试

- 单测 74 → 80 项：clampNarration 纯函数矩阵（上限换算/句读截断/非法秒数兜底）、分镜限长集成、提示词契约断言；e2e mock 旁白样本同步至新上限内。

## [2.0.2] - 2026-09-02

### Changed

- **BGM 独立为第⑥步、成片渲染置于最后（工作台七步）**：背景音乐从渲染区内嵌子块提升为独立步骤（搜索/试听/选用整段前移至配音之后），渲染成为第⑦ 步收尾；步骤条、新手说明卡、上一步/下一步导航与完成度计数同步扩展；「未选 BGM 也可渲染」给出明确提示。
- **工作台步骤条吸顶**：步骤导航条 sticky 固定在顶栏下方（毛玻璃底 + 滚动跟随高亮），长页面滚动中随时可跳转任意步骤、查看各步完成状态；锚点跳转预留吸顶条高度防止目标被遮挡；滚动跟随补齐配音/BGM/渲染三段并修正「滚到底 = 最后一步」。

### Added

- **主题切换（深色 / 浅色 / 跟随系统）**：顶栏新增主题按钮循环切换，选择持久化 localStorage；'system' 模式监听系统偏好实时跟随；`<head>` 内联初始化脚本先于样式渲染执行避免闪烁；浅色主题覆盖变量与少量硬编码深色（透明底 hover 白字、靛蓝浅字、spinner 等），视频/图片查看底与日志/JSON 终端风为刻意设计保持不变；`color-scheme` 随主题切换保证 UA 表单控件适配。
- 镜头标题输入框修复（深底无字色导致浏览器默认黑字隐形）：补文字颜色/焦点/占位符样式，BGM 搜索框补齐深色主题样式，`:root` 加 `color-scheme: dark` 根治 UA 控件黑底黑字问题。

### Fixed

- 启动时屏蔽 `node:sqlite` ExperimentalWarning（仅过滤该条，其余警告正常透传 stderr）。

## [2.0.1] - 2026-09-02

体验修正版：针对 v2.0 实测反馈的五处问题。

### Fixed

- **重试语义（高）**：`POST /api/tasks/:id/retry` 从「复制参数新建任务、旧失败记录永留」改为**原任务原地重置**——ID 不变，状态重置回 `queued` 重新走 队列中→生成中→完成/失败 完整流转；清空上次执行结果（video_id/错误信息/轮询计数/归档路径；图片任务清空产物列表，视频任务参考素材保留）；新增 `retry_count` 列记录重试次数，列表/看板/详情展示「已重试×N」徽标。响应从 201+新任务 改为 200+`{task, reused:true}`。
- **配音文稿取错来源（高）**：第⑤步默认配音文稿此前取「镜头标题 + 画面提示词首句」，把「开场/大全景/中景/主视角」这类画面描述当成旁白朗读——改为**只取每镜「旁白文案」字段**（无旁白时回退故事梗概），画面提示词绝不进入配音。
- **旁白字段没有完整使用链路（高）**：镜头卡片的「旁白文案」此前只能整体合成为不绑定镜头的整片配音（渲染器只用逐镜绑定配音，等于生成了也基本不生效）——新增**逐镜配音**：第⑤步「🎙️ 为所有镜头生成配音」按每镜旁白逐条合成并自动绑定 `shot_id`（渲染与画面对齐真正生效）；每张镜头卡新增「🎙️ 配本镜旁白」单镜按钮；原自由文稿合成保留为可选辅助入口。
- **全自动成片启动后页面无反应（中）**：启动顺序为「渲染页面 → 启动 auto」，首次渲染时 `auto_state` 为空导致时间线容器不存在，轮询无处更新、须手动刷新才能看到进度——改为**先启动 auto 再渲染页面**（首屏必含时间线），且时间线容器常驻（`hidden` 占位）、轮询局部刷新前强制取消隐藏。
- **`tasks.update` 参数错位（低，本轮引入即修）**：`updateTask` 预编译语句追加 `retry_count = ?` 时遗漏 SQL 列，参数绑定报 `column index out of range` 使提交器全线瘫痪——补齐并以「insert → update → retry 状态机」脚本验证。

### Added

- **任务来源上下文**：任务列表/看板/详情直接展示来源——项目名、镜头序号+标题（视频任务）、角色图/场景图（图片任务，`image_id` 溯源 + `request_json.image_kind` 兜底）、独立创作标记；列表行与看板卡片新增「📁 来源」徽标行。实现为 `getTask/listTasks/listProjectTasks` 三条查询 `LEFT JOIN projects/shots/project_images`，任务对象新增 `project_name/shot_seq/shot_title/image_kind` 字段。
- **镜头字段说明**：镜头卡的「画面提示词」「旁白文案」分设标签并注明用途（前者给视频模型生成画面，后者给人声朗读，互不混用）；镜头标题输入框注明「仅用于区分镜头，不会提交给模型、不会被朗读」。

### 测试

- e2e 新增：视频任务原地重试闭环（429 耗尽 → submit_error → retry ID 不变/retry_count=1 → 重新流转至 completed）、图片任务原地重试断言（复用/状态重置/结果清空）、任务来源上下文断言（视频带项目名+镜头、图片带项目名+角色图、独立任务 project_name=null）。

## [2.0.0] - 2026-09-01

围绕北极星「让零基础小白从一个想法到一部成片，全程不迷路」的体验大版本（P0–P3 四期）。

### Added

**P0 · 任务中心与创作中心体验重构**

- **任务中心时间线列表（默认视图）**：全部任务单列表按创建时间倒序展示（类型徽章 / 状态徽章 / 迷你进度条 / prompt 摘要 / 失败原因单行 / 相对时间 / 快捷操作），替代原「四列看板堆满一屏」；看板保留为右上角可切换的次要视图（列表 ⇄ 看板）。
- **真分页**：`GET /api/tasks` 响应新增 `total`（同筛选条件 COUNT），前端每页 10/20/50 条可选，轮询时页码与筛选不跳变，页码越界自动回退末页——百条任务不再一次全渲染。

**P1 · 图片任务统一进任务体系**

- `tasks` 表新增 `kind` 列（`video|image`，存量行 NULL 视为 video，自动迁移）。
- `POST /api/images/tasks` 异步图片任务入口：入队即返回，新增 `image-worker.js` 后台工作器接管（串行执行同步上游、429/网络/5xx 指数退避、产物本地归档）；挂项目时落 `project_images` 并首张自动定稿（与同步接口行为一致），独立创作（无 project）时产物留任务记录。
- 图片任务与视频任务共用列表 / 详情 / 删除 / 重试（`/retry` 复刻图片参数）/ 批量清理；详情弹窗展示图片墙，列表与看板卡片展示缩略图。
- 新建任务弹窗改「🎬 生成视频 / 🖼️ 生成图片」双 Tab：图片表单含示例模板 + AI 优化图片描述（五段式绘图提示词）。
- 工作台第③步同步接口 `/api/images/generate` 契约零变更。

**P2 · 大师成片（风格预设 + 高级配置）**

- **成片风格预设卡片**（治愈慢综 / 热血快剪 / 纪录解说 / 知识口播 / 童话绘本）：一键套用整套渲染配方（转场类型/时长 + 字幕样式/位置/字号 + BGM 音量 + 旁白增益/偏移），配「配方说明」人话解释当前配置；手动调参自动切换为「自定义」配方。
- **高级配置面板**（分组折叠默认收起）：转场组（xfade 类型白名单 fade/dissolve/wipeleft/wiperight/slideup/slidedown/circleopen + 时长滑杆）、字幕组（样式 white-outline/yellow-box/bottom-bar + 位置 bottom/center + 字号）、音频组（BGM/旁白增益/旁白偏移/闪避）、片头片尾卡。白名单进 `constants.js`，`routes/render.js` 校验 + `render.js` ASS Style 预设渲染。

**P3 · 全自动成片 + AI 自审闭环**

- **全自动成片编排器（`auto.js`）**：勾选「🚀 全自动成片」后，创意 → 文案 → 分镜 → L1 自审 → 角色图 → 逐镜视频 → 逐镜配音 → 渲染全自动推进：状态机持久化 `projects.auto_state`；每阶段自动重试 2 次；失败镜头自动重拍一次；TTS 失败/未配置 Fish Key 降级跳过不阻塞成片；卡住停在「人工介入」点可一键重启。新增 `POST/GET /api/projects/:id/auto` 与 `POST /api/projects/:id/auto/stop`。
- 前端全自动**进度时间线**（阶段打勾动画、最近事件、停止/重启按钮）。
- **L1 分镜 AI 自审**（`POST /api/projects/:id/storyboard/review`）：审查分镜与文案一致性 / 节奏 / 提示词质量，输出结构化修订建议（`{shot_seq, severity, field, issue, revised}`）；手动模式弹审查报告逐条采纳；全自动管道中低严重度自动采纳、高严重度留人工确认。
- **L2 质检报告**：渲染完成自动落 `render_jobs.quality`（成片时长 / 与分镜总时长偏差 / 实测响度 LUFS / 镜头数 / 旁白覆盖 / 字幕行数），渲染任务卡内直接展示。

### Changed

- **创作工作台分步向导化**：每步新增「💡 这一步做什么」新手说明卡（可折叠，开关记忆到 localStorage）、每步底部「上一步 / 下一步」导航（下一步带前置校验与引导提示）、顶部引导条附完成度计数（x/6 步）。
- 新建项目弹窗：风格从自由文本升级为 8 张**风格预设卡片**（仍可自定义输入）；主按钮改「创建并逐步制作」，新增「🚀 全自动成片」勾选项。

### Fixed

- **ffmpeg 封面提取死锁（高）**：`runFfmpeg` 缺 `-y -nostdin`，封面输出同名文件已存在（job id 复用）时 ffmpeg 打印 `Overwrite? [y/N]` 并阻塞等待管道 stdin 应答（父进程永不写入）→ 渲染永久卡在 rendering。e2e 曾因此陷入「失败 → 残留封面 → 挂死 → 再失败」恶性循环，本次同时让 e2e 启动即清理上次失败运行的产物残留。
- **db 参数绑定**：`tasks.insert` 可空字段传 `undefined` 时 `node:sqlite` 直接抛「cannot be bound」（图片任务无 seconds 首次触发），可空列统一 `?? null` 归一化。
- e2e mock 服务器响应补 `Connection: close`，消灭 keep-alive 连接复用竞态（undici 池中的死连接会让 worker 的 fetch 挂到 headers 超时，表现为轮询停摆数分钟）。

### 测试

- 单测 61 → **74 项**（新增 ASS 字幕样式/位置/非法值兜底等）；e2e 断言 65 → **72 项**（新增：异步图片任务三组闭环、分页 `total` 字段、L1 审查、全自动成片端到端闭环含 L1 修订自动应用断言、渲染新参数透传）。

## [1.9.2] - 2026-09-01

### Fixed

- **渲染任务卡死自愈（并发审计发现·高）**：渲染中进程崩溃/被杀后任务永久卡在 `rendering`（删除接口拒绝该状态，用户无任何解卡途径）——渲染器 `start()` 现在把孤儿 `rendering` 任务复位回 `queued` 重新渲染；e2e 新增「复位 → 重渲染完成」闭环用例。对照：tasks 域早有两层自愈，render 域此前为零。
- **单实例锁 TOCTOU（并发审计发现·中）**：锁获取是「读检查 → 写」两条语句，双进程同时启动可都拿到锁并都启动 worker。改为单条 upsert CAS（语句级写锁天然原子）。**过程中的证伪**：先尝试 `BEGIN IMMEDIATE` 事务包裹，跨进程并发实测**不产生互斥**（两进程同时通过检查各自写入），弃用并记录；CAS 方案经双进程并发脚本 3 轮验证恰好一个成功。语义微调：持有者死亡但心跳未过期时改为等过期（≤15s）再接管，顺带规避 Windows pid 复用误判。
- **poller 快照陈旧可把 completed 改判 failed（并发审计发现·中）**：长 tick 进行中，手动「立即查询」已完成某任务后，轮到它时仍按陈旧快照走超时分支可能改判 failed、或重复归档下载。`_pollOneInner` 现在以最新库内状态为准，终态直接跳过。
- **drawtext 滤镜 `%` 转义缺失（注入面审计发现·低）**：`escDrawtext` 此前只转义 `\ ' :`，`%{expr}` 会被 ffmpeg 表达式引擎求值（无命令执行能力，但可致渲染失败或封面显示非预期值）。补 `%` 转义并导出单测覆盖。
- 其余注入面审计结论（SQL 全参数化、静态服务无路径穿越、spawn 数组传参无 shell 注入、SSRF 面在本地单人语境可接受）：**无风险，未改动**。

### Changed

- 删除死代码：`tasks.stuck()` 与 `stuckTasks`（与 `pendingSubmitTasks` 查询完全相同的 v1.3 前身，全仓无调用方）。

## [1.9.1] - 2026-09-01

### Fixed

- **音乐接口不可达透传**：fetch 网络层失败（连接被拒/DNS/超时/TLS）由笼统 500 改为 502 + 可操作提示（确认服务已启动与地址端口正确）。
- **重试保留溯源**：`/api/tasks/:id/retry` 重试不再丢失 project/shot/image 关联——网络波动重试不再导致成片渲染跳过镜头。
- **试听流防崩溃**：BGM 试听流代理改用 `stream.pipeline` 转发——上游断流时裸 `.pipe()` 会把 error 抛成 uncaughtException 导致整个进程退出。
- **网络异常退避引用修复**：submitter 网络异常重试路径的未定义变量（静态检查捕获，该路径此前无测试覆盖）。

### Changed

- **server.js 分层拆分**（1678 行 → 132 行装配层，54 条路由行为零变更，e2e 全程守护）：
  - `constants.js`（模型清单/参数白名单/上限/TTS 预设，零依赖）
  - `config.js`（DEFAULT_BASE_URL / probeDuration / RENDER_PARAMS_DEFAULTS 单源——原 base_url 4 处硬编码、probeDuration 双实现漂移、渲染默认值双定义全部收敛）
  - `errors.js`（ApiError + ah 统一错误协议，netmusic 裸 Error+expose 私有协议并入）
  - `services/`（payloads 校验与构建 / prompts 模板与 LLM 解析 / voice-pool 备选池 / pipeline 依赖注入）
  - `routes/`（meta / settings / tasks / llm / images / tts / music / projects / render 九域，注册顺序与原文件一致）
- **前端公共工具收敛**：`public/common.js` 统一 esc/api/fmtTime/toast/$ 工具——原三份逐字拷贝（app/workspace/compare），两份 `api` 行为已分叉（workspace 版不设 `err.status`）。

### Added

- **单元测试 61 项**（jest，`test/unit/`）：payload 校验矩阵（V2.5/V2.0/图片三套）、LLM 输出容错解析、分镜规范化、ASS 字幕生成（CJK 预换行/行首标点回收/防注入）、提交退避数学（提取 `computeBackoffMs` 纯函数）。
- **工具链**（devDependencies，运行时依赖仍仅 express）：jest 30 + eslint 10（flat config）+ prettier 3（printWidth 120）；CI 升级为 lint → format:check → jest → e2e 四步。

## [1.9.0] - 2026-08-30

### Added

- **声音广场（音色备选池）**：接入 fish.audio 社区音色市场——`GET /api/tts/market` 代理浏览（`sort_by` 热门趋势/最多使用/最新收录，语言/性别/年龄标签过滤），返回音色 id、点赞数、使用量与试听样例；工作台第⑤步新增「🎤 声音广场」面板：浏览 → ▶ 试听 → 「＋备选」加入**音色备选池**（`tts_voice_pool` 落库，池内音色自动合并进所有音色下拉，`POST/DELETE /api/tts/pool` 管理）。替代原 5 个固定预设音色。
- **设置**：新增 `fish_web_token`（fish.audio 网页端 Token，仅服务端使用，浏览器只读 `fish_web_token_set` 布尔）。
- mock e2e：备选池 CRUD、音色清单合并断言。

## [1.8.2] - 2026-08-30

### Fixed

- **字幕换行**：libass 对无空格 CJK 长句不做自动换行（WrapStyle 0 亦无效），长台词字幕横向溢出画面。改为生成器主动预换行——按字号×可用宽度计算每行字数显式 `\N` 换行，行首标点自动回收到上一行行尾。《墨白》E01 实测发现。

## [1.8.1] - 2026-08-30

### Added

- **响度测差补偿**：单遍 loudnorm 在稀疏人声内容上会欠校准（实测 -19 LUFS）。渲染完成后 ebur128 探测综合响度，偏差 >1.5dB 时音轨直补（视频流免重编码），至多两轮至 -16±1.5。
- **任务关联**：`POST /api/tasks` 支持可选 `project_id/shot_id`（校验归属）——图生视频产线（keyframe 直提任务）保留镜头溯源。

## [1.8.0] - 2026-08-29

### Added

- **竖屏 9:16 产线**：成片渲染方向感知——`aspect` 参数（16:9 / 9:16，默认跟随项目画幅），归一化、片头/片尾卡、字幕（PlayRes 与安全边距自动适配手机底部 UI 区）全链跟随方向；竖屏输出 720×1280@30，直通抖音/快手/视频号。
- **封面自动生成**：渲染成功后自动抽取 3 张关键帧候选（18%/50%/82% 片长处）落 `data/artifacts`，首张叠片名；`render_jobs.covers` 落库，任务详情与工作台渲染卡直接展示缩略图与下载。best-effort：失败不影响成片。
- mock e2e 渲染用例升级为竖屏端到端（720×1280 尺寸断言 + 封面存在断言）。

## [1.7.0] - 2026-08-29

### Added

- **多镜头重拍**：镜头级候选机制——`POST /api/projects/:id/shots/:shotId/retakes`（count 1–3，提交队列自动按分钟节流）为单个镜头一次提交多条候选；完成后在镜头行「候选区」点选定稿 take（`POST .../select-take`，`task_id=null` 恢复自动模式，同镜头互斥天然成立）。`shots.take_task_id` 落库（迁移新增），**成片渲染优先使用选定 take**、未选定时回退最新完成条；删除定稿任务自动清引用回退自动模式。
- 工作台第④步：镜头行新增「📸 重拍」按钮与候选条区（`#任务号 ✓定稿 / 用这条 / 取消定稿`）。
- mock e2e 扩展到 **65 项**：重拍候选提交、定稿选定、collectSegments 优先定稿、跨镜头 404、删除定稿回退。

## [1.6.0] - 2026-08-29

### Added

- **字幕烧录**：成片渲染支持把每镜旁白文案按「旁白起点 → 配音结束」精确时间轴烧录为字幕（ASS 格式：底部居中、奶油色描边字、150ms 淡入淡出、自动裁剪不越过镜头叠化边界）。渲染参数新增 `burn_subtitles`（默认开）/ `subtitle_fontsize`（24–72，默认 42）；工作台第⑥步新增「烧录字幕」开关与字号选择。字幕时间轴生成 `buildSubtitleAss` 为纯函数，e2e 直接断言时间轴格式、文本转义与无效区间剔除。

## [1.5.0] - 2026-08-29

> 主题：让 BGM、旁白、配音作为一个整体被专业地混音（声音设计协调）。

### Added

- **专业旁白链**：成片渲染的每条旁白配音现在经过 `90Hz 高通（去低频浊音）→ 轻压缩（平衡句间动态）→ 增益（`narration_volume`，默认 140%）→ 按镜头起幅点对齐` 处理，人声清晰稳坐音乐之上。
- **终局响度标准化**：混音最后一级统一为 EBU R128 单遍 `loudnorm`（-16 LUFS / TP -1.5 / LRA 11）+ 限幅 —— 不同成片之间音量一致，不再忽大忽小。
- **旁白绑定镜头**：新增 `POST /api/tts/:id/bind` —— 旧项目的整片旁白可以逐条绑定到镜头（kind 自动转 shot，同镜头互斥自动让位，`shot_id=null` 解绑），配音墙每条记录新增「绑定到镜头」下拉；渲染面板新增「🎙️ 旁白 N/M 镜」覆盖率提示与「旁白增益」滑杆（80–220%）。
- **闪避调优**：sidechaincompress 参数改为阈值 0.035 / 比率 9 / 起音 40ms / 释放 450ms —— 说话时音乐让路、句间自然回升，不再生硬。
- mock e2e 扩展到 **64 项**：镜头旁白注入走完整混音链（高通+压缩+增益+闪避+响度）、旁白音量参数、绑定/互斥/解绑/跨项目 404。

## [1.4.0] - 2026-08-29

### Added

- **在线 BGM 配乐**：接入自托管音乐接口（网易云源，Token 认证）。工作台第⑥步新增「🎵 背景音乐」——搜索歌曲（`GET /api/music/search` 代理并规范化字段）、▶ 试听（`GET /api/music/stream` 服务端流代理，播放地址有时效性故现取现播）、一键选用（`POST /api/projects/:id/bgm`，立即下载到 `data/artifacts` 缓存 `bgm-<id>-<level>.mp3` 并落库到 `projects.bgm`）、清除。
- **渲染 BGM 混音**：成片渲染自动铺设所选 BGM——`-stream_loop` 循环铺满片长、`atrim` 裁剪、首尾 `afade` 淡入淡出；**有旁白时默认开启「旁白闪避」**（`asplit` + `sidechaincompress`：旁白起时自动压低音乐，让人声突出），无旁白时自动抬升 BGM 音量；BGM 音量可调（默认 35%）。渲染参数新增 `bgm_volume` / `bgm_duck`。
- **音乐接口设置**：设置弹窗与 API 新增 `music_api_base` / `music_api_token`（仅存本地 SQLite、只做服务端调用，浏览器只见 `music_api_token_set` 布尔）/ `music_level`（standard/exhigh/lossless/hires）。
- mock e2e 扩展到 **62 项**：音乐搜索代理、Token 不泄露、非数字 song_id 拦截、选用下载缓存、渲染带 BGM、清除选择。

## [1.3.0] - 2026-08-29

> 依据一次完整的真实创作实战（《种星星的人》全流程 AI 短片）回归审视产品后的改造：
> 把「素材生产器」补全为「可出成片的创作工作站」。

### Added

- **一键成片渲染**：新增 `POST /api/projects/:id/render` 等端点与工作台第⑥步「🎞️ 成片渲染」——把已完成镜头视频（本地归档优先）与逐镜旁白在本地用 ffmpeg 合成完整短片：两遍式流程（各段归一化 1280×720@30 → xfade 链式叠化 → 旁白按镜头起幅点 `adelay` 对齐 → `amix`+`alimiter` 混音），可选片头/片尾卡（星野 + 片名 / 场景图压暗），`-progress` 实时回写进度，产物落 `data/artifacts/` 可直接播放/下载。需本机 ffmpeg。
- **服务端提交队列**：任务创建改为「入队」语义，新增后台提交器 `submitter.js`——按模型读取 `submit_interval_ms` 服务端强制节流，**429 限流自动指数退避重试（默认 60s 起、5 次上限）**，网络错误/5xx 同样退避；重试耗尽才落 `submit_error`。批量提交不再因上游「1 次/分钟」限流产生撞墙死记录（实战中 8 镜首轮 6 条失败的问题根治）。
- **视频本地归档**：任务完成即自动下载视频到 `data/artifacts`（`tasks.video_local_path`，API 返回 `video_local_url`），前端播放/下载优先本地；启动时自动补扫历史已完成任务。远端链接过期不再丢素材。
- **superseded 失败治理**：项目任务聚合中，同镜头已有 `completed` 任务时，旧 `failed/submit_error` 自动标记 `superseded:true`（仅响应层，不改库），前端显示「已作废」徽标——看板不再被废提交记录误导。
- **分镜旁白**：分镜生成（LLM）同步产出每镜 `narration` 旁白文案（与画面互补、连起来成篇），`shots` 表新增列，工作台分镜卡片可编辑并一键按镜头合成配音（TTS `shot_id` 绑定，成片渲染按镜头对齐时间轴）。
- **镜头级引用开关**：`shots.use_character_ref`（默认开）——纯空镜/无人镜头可关闭角色图引用，以纯文生模式提交（不要求角色定稿图、不注入 `<Picture 1>` 前缀）；纯风景项目不再被 400 挡住。
- **API 自描述**：新增 `GET /api/openapi.json`（轻量 OpenAPI：路径 + 摘要 + 关键语义说明，自动化脚本 / AI Agent 无需读源码即可对接）；`/api/meta` 的 `models[].rate_limit` 下发上游限流提示。

### Changed

- **提交语义**：`POST /api/tasks`、重试、镜头/项目视频提交统一为「入队即返回 201（queued）」，提交由后台完成（响应中不再即时含 `video_id`，`submitted_at` 记录实际提交时间；轮询超时基准同步改为 `submitted_at`）。
- 悬挂任务清理（原 poller `cleanStuck`）职责移交提交器：待提交任务不再按创建时长误杀。
- mock e2e 扩展到 **59 项**：429 自动重试、服务端提交节流、本地归档、superseded、分镜旁白落库、纯空镜 text 模式 payload、成片渲染真实 ffmpeg 端到端（含产物时长与删除清理）、`/api/openapi.json`、meta 限流提示。

## [1.2.0] - 2026-08-29

### Added

- **分镜脚本结构化（M2 核心包）**：
  - 创意 → 多镜头分镜：`POST /api/llm/storyboard` 按指定镜头数（自动/3/5/8）一次生成整段分镜（每镜头标题 + 视频提示词 + 时长），整体作为 `storyboard` 文本版本落库（多版本可回溯/选用），解析后重建 `shots` 镜头工作副本。
  - 工作台第②步「分镜脚本」区：镜头卡片独立编辑（标题/提示词/时长）、增删、上下移排序；「升级为分镜」一键把旧的单条视频提示词变成 1 个镜头（旧项目无感迁移）；「重新生成分镜」confirm 覆盖；历史版本选用即重建镜头。
  - 工作台第④步：按镜头提交（每个镜头一条独立视频任务，引用定稿角色图 + `<Picture 1>` 注入）+「批量提交未完成镜头」——前端按设置间隔节流逐个发起，进度可停；任务列表按镜头分组展示。
  - 新设置项「批量提交间隔 (ms)」`submit_interval_ms`（默认 60000，0 = 连续提交），后端校验 0–300000。

### Changed

- **架构（M2 前置改造）**：新建 `pipeline.js` 服务层，「角色定稿图 → 提示词回退链 → `<Picture 1>` 注入 → 入队」编排从路由抽出复用；`projects.status` 退役（列保留兼容，工作台步骤指示改纯聚合推导）。
- DB 新增 `shots` 表（含项目索引），`tasks` 迁移新增 `shot_id` / `text_id` / `image_id` 溯源列与索引；项目删除级联清理镜头。
- 项目详情聚合返回 `shots`；旧端点 `POST /api/projects/:id/videos` 行为不变（无分镜项目继续可用）。
- mock e2e 扩展到 **47 项**：分镜生成/重生成/版本选用、镜头 CRUD 与排序、跨项目越权 404、单镜头提交溯源（shot_id/image_id）、submit_interval_ms 设置校验。

## [1.1.1] - 2026-08-28

### Added

- **前端元数据单一事实来源**：新增 `GET /api/meta`（模型/画幅/时长/图片清单），任务中心与创作工作台的全部下拉与提示文案改为动态渲染，新增模型只改后端一处。

### Fixed

- **创作工作台**：提交视频后任务看板立即刷新（此前 `window.__app.loadTasks` 未暴露导致静默失效）；修复「删除项目」按钮事件被重复绑定覆盖（丢失确认信息与成功提示）；提交视频/生成文案/生成角色图增加防重入（避免双击重复计费）；异步生成完成不再把已离开项目详情的用户强行拉回；文案编辑中不再被整页重绘清空未保存内容；工作台第④步任务进度每 10 秒自动更新。
- **任务中心**：刷新循环防请求堆积与乱序覆盖；服务不可达时顶栏显示「连接中断」并节流提示、恢复后自动复原；详情弹窗操作栏仅在按钮集合变化时重建（不再每 2 秒吃掉点击）；任务被删除/清空后详情弹窗自动关闭（不再静默 404）；「立即查询」改为原地刷新不再销毁弹窗；筛选/搜索无结果时空态文案与全局空态区分；旧库 v2.0 默认模型在设置弹窗不再静默丢失选中。
- **后端校验加固**：`/api/llm/chat` 补 messages 形状/条数/role/temperature/max_tokens/model 白名单校验；`/api/llm/script`、`/api/images/generate` 补长度上限与取值范围（自定义图片尺寸每边 ≤4096、输入图 ≤5 张）；项目 PATCH 补 status 枚举与 name 非空校验；修复文案编辑接口的跨项目越权（IDOR）；视频/图片外链 URL 落库前强制 http(s) scheme。
- **健壮性**：新增 `unhandledRejection` / `uncaughtException` 进程级兜底；手动「立即查询」与后台轮询并发互斥（旧响应不再覆盖新状态）；已终结任务不再被轮询超时保护误标为失败；项目删除/文案定稿/图片定稿/批量清空改多语句事务；错误中间件增加 headersSent 守卫，500 不再回显内部错误详情。
- **测试与基建**：mock e2e 从 25 项扩展到 **40 项**（补齐 13 个零覆盖端点、级联删除断言、400 错误信息断言）；测试改用独立 artifacts 目录并在结束后清理，不再污染生产 `data/`；启动等待改为健康检查轮询（消除 CI flaky）；mock 文本模型按结构化契约而非提示词措辞分派；CI 语法检查补齐 `workspace.js` / `db.js` / `poller.js`。

### Changed

- `ARTIFACTS_DIR` 支持 `DATA_DIR` 环境变量覆盖（此前只影响数据库路径）。
- 清理死代码：未接线的 `tasks.clearAll`、3 个未使用的预处理语句、`.gitignore` 中无效的 `!.env.example` 规则。

## [1.1.0] - 2026-08-28

### Added

- **创作流水线 M1（工作台 + 任务中心）**：
  - 顶部导航分流「🎬 创作工作台」与「📋 任务中心」。
  - 工作台项目制四步流水线：创意 → 文案与提示词 → 角色设定图 → 视频生成。
  - 文本模型 `agnes-2.5-flash` 接入：创意生成结构化文案（故事梗概 / 视频提示词 / 角色外观 / 场景），JSON 解析容错，4 类文案可手动编辑保存、多版本选用。
  - 图片模型 `agnes-image-2.1-flash` 接入：文生图/图生图，同步生成，产出 Agnes CDN URL 并自动下载本地备份（`/artifacts` 静态服务），角色图墙单张定稿。
  - 项目发起视频：自动组装 `agnes-video-2.5-flash` reference 模式（定稿角色图 + `<Picture 1>` 提示词注入 + 项目时长/画幅），任务入队并关联 `project_id`。
  - 新建视频表单增加「✨ AI 优化提示词」按钮（调文本模型优化手写描述）。
  - 任务中心模型收敛：默认 `agnes-video-2.5-flash`，付费 2.5 收进「高级」分组，**`agnes-video-v2.0` 旧模型界面下架**（后端兼容层保留，历史任务正常显示）。

### Changed

- `agnes.js` 扩展 `chatComplete()` / `generateImage()`（图片 180s 长超时）。
- DB 新增 `projects` / `project_texts` / `project_images` 三表，`tasks` 增加 `project_id` 列（自动迁移）。
- mock e2e 扩展到 **25 项**，新增 chat/images 端点模拟与流水线全链路用例。

## [1.0.2] - 2026-08-28

### Changed

- 看板「已完成」列视频组件全面优化：
  - 卡片只保留轻量预览（首帧缩略图 + 播放按钮遮罩 + 时长角标），点击进入详情弹窗大播放器，不再内嵌满屏播放器。
  - 悬停卡片预览时静音自动播放，移出后暂停并回到开头。
  - 滚动懒加载（IntersectionObserver）：只有预览进入视口才加载视频元数据，任务多时页面不再卡顿。
  - 时长角标在元数据加载后用真实时长校正。

## [1.0.1] - 2026-08-28

### Fixed

- **任务列表接口占位符参数缺失**：SQL 有 6 个占位符但只绑定 5 个参数，导致 `/api/tasks` 始终返回空数组（看板看不到任何任务，即使统计栏有计数）。已修复并加入回归测试。
- **兼容真实 API 的 `pending` 状态**：真实接口在排队等待时返回 `status: pending`（文档未提及），原逻辑会误判为 `failed` 且不产生任何日志。现在 `pending/processing/running` 一律按“队列中”继续轮询，不会误杀。
- **兼容真实 API 的顶层 `url` 字段**：实测完成响应中视频地址位于顶层 `url`（文档写的是 `metadata.url`），现在两者都兼容，已完成任务能正确显示/播放视频。

### Changed

- 状态筛选 chips 现在真正生效：选中某个状态时看板只显示该列（单列聚焦视图），「全部」显示四列。
- 提交任务失败后立即刷新看板，`submit_error` 任务马上出现在「失败」列。

## [1.0.0] - 2026-08-28

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
