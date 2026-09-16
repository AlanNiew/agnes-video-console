# 分支治理与并行会话手册

> 目的：**每个分支只做自己的事**，避免"功能开发"与"创作内容"互相污染、避免多会话在同一工作区互相切分支。
> 本文件是唯一权威；`AGENTS.md`、`docs/PLATFORM_PUBLISH_PLAN.md` 与本文件冲突时以本文件为准。

---

## 一、分支模型

| 分支            | 职责                                                                  | 合并去向                                        |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `main`          | 集成/稳定：**只含平台能力**（服务端、接口、页面、工具脚本、平台文档） | 接受已验证的 `feature/*`、`fix/*`               |
| `feature/*`     | 平台功能开发（Agnes 接入、接口、页面、即梦 CLI、发布包…）             | 完成后合 `main`                                 |
| `fix/*`         | 平台缺陷修复（也可直接在 `feature/*` 内做）                           | 完成后合 `main`                                 |
| **`content/*`** | **创作内容**：剧本/分镜/企划/制作记录/台账/复盘/策展发布文案          | **长期并行，不合 `main`**（定期从 `main` 同步） |
| `backup/*`      | 危险操作前的快照                                                      | 不动                                            |

命名：一律 ASCII（`content/gentouya-s1`、`feature/dreamina-integration`）——避免中文分支名带来的工具兼容问题。

## 二、路径归属（机械可校验）

| 归 `content/*`                                    | 归 `feature/*` 与 `main`                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `docs/stories/**`（企划/考据/制作记录/台账/复盘） | `server.js` `core/` `clients/` `db/` `lib/` `services/` `workers/` `routes/` `public/` `test/` |
| `tools/episodes/**`（每集分镜配置）               | `tools/*.js`（脚本：preflight / card-preview / series-new-episode / branch-guard）             |
| `tools/publish/**`（发布策展文案）                | `AGENTS.md` `CHANGELOG.md` `package.json`、其余 `docs/*`（playbook / backlog / 计划 / 本文件） |
| —                                                 | `data/**` **永不入 git**（已 gitignore）                                                       |

> 例外：`docs/CREATION_PLAYBOOK.md` 留在 `main`（被 `AGENTS.md` 引用，属稳定资产）；新的创作经验写进 `docs/stories/`。
> 过程文件白名单（任何分支都可提交）：`docs/BRANCHING.md`、`tools/branch-guard.js`、`.githooks/**`。

## 三、会话纪律（每条都对应真实事故）

1. **开工先确认分支**：`git branch --show-current` —— 不在自己职责的分支上，先停下问，不要动手。
2. **禁用 `git add -A` / `git add .`**：共享工作区会把**别人的未提交改动**一并卷进你的提交
   （真实事故：E05 提交里混进了即梦分支的 6 个 WIP 文件）。
   → 只用**明确路径** `git add <path...>`，提交前 `git status --short` 核对清单。
3. **跨会话不切分支、不 reset、不 rebase**：必须切时先互相喊停并确认工作区干净。
4. **提交信息含双引号会被 PowerShell 拆参** → 用 `git commit -F <消息文件>`。
5. **触摸平台代码后必须跑**：`npx prettier --check .`、`npm run lint`、`npm run test:unit`、`npm run test:mock`、`npm run build`。
6. **`/undo` 与 `/redo` 基于 git**：同一目录里两个会话共享索引，一个会话回退可能撤掉另一个的改动 → 并行请用独立工作区（见下）。

## 四、并行工作区（推荐：`git worktree`）

git 的"当前分支"属于**工作目录**，不属于会话/终端。同一目录里的两个会话永远共享同一个分支。
要让每个会话各自一个分支，就给它们各自一个目录：

```bash
# 为创作分支开独立工作区（不进主目录，不打扰任何进行中的工作）
git worktree add ../agnes-content content/gentouya-s1
cd ../agnes-content && npm install      # worktree 不共享 node_modules（已 gitignore）
cd ../agnes-content && opencode         # 在该目录启动创作会话（也可 opencode ../agnes-content）
```

**必须约定的三件事：**

1. **数据共享**：`data/`（SQLite + 素材/成片）不入 git，两个工作区各有自己的 `data/`。
   创作会话指向主目录数据：`DATA_DIR=<主目录>\data`、`PORT=8274`。
2. **单实例工作锁**：同一 `DATA_DIR` 下，**同一时刻只有一个实例的 worker 在跑**（另一个仅提供 API，
   AGENTS.md 的 5 个后台 worker 均受锁约束）。→ 约定：**谁要做生产（提交/配音/渲染）谁持有应用**；
   平台会话跑 e2e 时自带独立 `DATA_DIR` 与端口（8391/8392），互不干扰。
3. **临时 worktree 用完即弃**：`git worktree remove ../agnes-main`（不要 `rm -rf` 目录，会让 git 残留记录）。

其它可选：`opencode serve` + `opencode attach --dir` 可把 UI 挂到指定目录；`OPENCODE_EXPERIMENTAL_WORKSPACES`
是实验开关（官方文档未展开语义），不作为依赖。

## 五、机械护栏：`tools/branch-guard.js`

按**当前分支**校验暂存路径，越界直接拦下：

```bash
node tools/branch-guard.js                       # 校验暂存文件（pre-commit 即调它）
node tools/branch-guard.js --paths tools/episodes/S1E05.json   # 自测某组路径
BRANCH_GUARD_ALLOW=1 git commit ...               # 紧急放行（慎用，需在提交信息里说明）
```

启用为 pre-commit hook（每个克隆一次）：

```bash
git config core.hooksPath .githooks
```

## 六、历史与例外（不追溯）

E01–E05 期间创作与平台提交交织在同一支线上（当时尚无本规范），**不做历史重写**；
本规范自 v2.5.5 起生效：此后新创作只进 `content/*`，`main` 只收平台变更。
已知历史遗留：`main` 中包含 E01–E05 的创作文件提交。
