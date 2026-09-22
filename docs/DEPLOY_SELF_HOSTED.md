# 自托管部署方案（Ubuntu 24.04 · 域名 + HTTPS + Basic Auth）

把一个**只监听 127.0.0.1 的本地控制台**变成**服务器上常驻的生产服务**。本方案**不改一行业务代码**：
应用本来就绑定回环地址、前端全用相对路径，反向代理对它零侵入 —— 变的只是「它跑在哪台机器、谁的数据目录、怎么被访问」。

> 决策基线（2026-09-22 确认）
>
> | 项       | 选择                                | 直接代价                                                        |
> | -------- | ----------------------------------- | --------------------------------------------------------------- |
> | 迁移范围 | **只迁代码 + 数据库**，作品库从零攒 | 服务器看不到历史成片，旧项目不能重渲（可事后按第 9 节的 B+ 补） |
> | 公网入口 | **域名 + HTTPS + Basic Auth 反代**  | 需要域名解析 + 证书 + 一次 sudo（未备案 → 用 8443 端口）        |
> | 配音     | **服务器暂不做配音**                | 服务器出的成片**无旁白**（字幕仍在，取自分镜脚本原文）          |
>
> 本文用 `<ssh别名>` 代指你 `~/.ssh/config` 里配好的服务器别名，`<域名>` 代指你的域名，路径按 `alan` 用户写。

## 0. 实测体检结论

**服务器**（Ubuntu 24.04.3 LTS · x86_64 · 2 vCPU / 1.7 GB RAM / 4 GB swap / 40 GB 盘）

| 检查项       | 实测                                                                                                               | 对部署的含义                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 磁盘         | 已用 20 GB，**可用 19 GB**                                                                                         | 装不下本机 21.2 GB 的 data/（works 9.2 + artifacts 12）→ 本方案只迁库 |
| 内存         | 可用 ~1.2 GB，且 `earlyoom` 在跑                                                                                   | 渲染可行但不宽裕：别并发跑渲染，盯 OOM 日志                           |
| Node         | `/usr/bin/node` **v22.22.1**，`node:sqlite` 实测可用                                                               | 满足 ≥22.13 硬要求，无需装运行时                                      |
| ffmpeg       | ✓ 带 `libx264` / `aac` / `drawtext` / `loudnorm`                                                                   | 渲染与字幕全部可用                                                    |
| **中文字体** | ✗ 渲染 worker 认的三个 Linux 路径**全缺**                                                                          | **必须 sudo 装字体**，否则片头/片尾卡文字静默丢失                     |
| systemd      | `--user` 可用，`Linger=yes`                                                                                        | 可零 sudo 做到开机自启、崩溃自拉、退出 SSH 不停                       |
| git/rsync/…  | ✓ git、rsync、sqlite3、tmux、python3、docker                                                                       | 部署与备份工具齐全                                                    |
| npm registry | ✓ 可达（单次往返 ~4.4 s）                                                                                          | `npm ci` 能跑，就是慢一点                                             |
| Agnes API    | ✓ `apihub.agnes-ai.com` 301/2.6 s                                                                                  | **主链路在服务器上可用**（这是本方案成立的前提）                      |
| Agnes CDN    | ✓ `cos-…agnes-ai.cn` 1.11 MB/s；`platform-outputs…space` 0.84 MB/s                                                 | 产物下载/归档速度可用（渲染素材主要瓶颈）                             |
| 墙外站点     | ✗ google / X / **api.fish.audio 全超时**；服务器自带 ss-local（127.0.0.1:1080 → 境外节点）对这三个目标**同样不通** | 配音无法在服务器闭环 → 按基线停用（第 4 节）                          |
| nginx        | 自编译 1.24.0，`--prefix=/usr/local/nginx`，已 `include conf.d/*.conf`；**未编译 http_v2 模块**                    | 可加 server 块做反代，但**不能启用 HTTP/2**；8443 空闲                |
| UFW          | `ENABLED=yes`                                                                                                      | 新端口要 `ufw allow`，另需云控制台安全组放行                          |
| sudo         | **需要密码**                                                                                                       | 系统级步骤（字体/nginx/防火墙）由你亲自执行，本文已分组               |
| 已占端口     | 80（nginx）、5432、26739、15001、15002、18293、35722、12345                                                        | 8273 与 8443 均空闲                                                   |

**本机（Windows）**

| 检查项         | 实测                                                            | 对部署的含义                                          |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| 代码状态       | 分支 `main` **领先 `origin/main` 7 个提交**                     | **必须先 push**，否则服务器 clone 到 7 个提交前的代码 |
| 数据库         | 4.48 MB（805 任务 / 48 项目 / 479 分镜 / 151 渲染任务）         | 小，一次 scp 即可                                     |
| 库内路径       | 1309 行 Windows 绝对路径（含 146 行历史遗留 `lib\data` 前缀）   | 迁移后必须改写，见第 3 节                             |
| 库内被引用产物 | 去重后 **466 个文件 / 627 MB**（+镜头视频则 1108 个 / 2.46 GB） | 第 9 节 B+ 的性价比依据                               |

## 1. 目标架构

```
┌─ Windows 工作站（保留）──────────────┐        ┌─ 服务器 Ubuntu 24.04 ──────────────────────┐
│ 创作 / 配音 / 历史成片库             │        │ systemd --user: agnes-console.service      │
│ D:\…\agnes-video-console\data        │  scp   │   /usr/bin/node server.js                  │
│   works 9.2 GB · artifacts 12 GB     │──快照─▶│   ↳ 127.0.0.1:8273（只监听回环，不对外）    │
└──────────────────────────────────────┘  4 MB  │ ~/ai-video/data/{agnes-console.db,…}       │
                                               │ nginx 8443: HTTPS + Basic Auth → 反代 8273 │
                                               │ DNS <域名> A → 服务器公网 IP               │
                                               └────────────────────────────────────────────┘
数据流（服务器侧）：提交 → Agnes API → poller 归档 artifacts → ffmpeg 渲染 → works/发布包
```

目录布局（服务器）：

| 路径                                           | 内容                                     |
| ---------------------------------------------- | ---------------------------------------- |
| `~/ai-video/app`                               | git clone 的代码（`main` 分支）          |
| `~/ai-video/data`                              | `DATA_DIR`：库 + `artifacts/` + `works/` |
| `~/ai-video/backup`                            | 每日数据库快照                           |
| `~/ai-video/incoming`                          | 从本机 scp 过来的库快照暂存              |
| `~/.config/systemd/user/agnes-console.service` | 服务单元（由模板渲染）                   |

## 2. 分阶段总览

| 阶段 | 内容                                     | 执行者   | 预计      |
| ---- | ---------------------------------------- | -------- | --------- |
| 1    | 本机：push 代码 + 快照库 + scp           | 你/我    | 5 min     |
| 2    | 服务器：clone / 依赖 / 构建 / 起服务     | 一条脚本 | 5–10 min  |
| 3    | 数据库迁入 + 1309 行路径改写             | 你/我    | 5 min     |
| 4    | 按服务器现实调 4 项设置（停配音等）      | 你/我    | 2 min     |
| 5    | sudo 装中文字体（唯一必须的系统级依赖）  | **你**   | 2 min     |
| 6    | 公网入口：nginx 8443 + 证书 + Basic Auth | **你**   | 20–40 min |
| 7    | 验收：预检 + 浏览器 + 真跑一集           | 你/我    | 30–60 min |

## 3. 逐步操作

### 第 1 步 · 本机：推送代码 + 一致性快照

```powershell
cd D:\Programing\AI_Video_Create\agnes-video-console
git status -sb                     # 期望 "## main...origin/main [ahead 7]"，工作区干净
git push origin main               # ★ 必须先推：否则服务器拿到的是 7 个提交前的代码

# 库快照：VACUUM INTO 跨 WAL，控制台在跑也安全（想彻底干净可先停本机服务）
node tools/db-snapshot.js --out ..\.scratch\agnes-console-snapshot.db
#  → 打印源库/快照大小 + 完整性检查 ok

scp ..\.scratch\agnes-console-snapshot.db <ssh别名>:~/ai-video/incoming/
```

> 不想 push 也可以：`git bundle create ..\.scratch\agnes-main.bundle main` 后 scp 过去，在服务器
> `git clone ~/ai-video/incoming/agnes-main.bundle ~/ai-video/app` 并 `git remote set-url origin <仓库地址>`。
> 代价是以后更新要重复 bundle。**推荐直接 push**。

### 第 2 步 · 服务器：一条脚本起服务（零 sudo）

```bash
ssh <ssh别名>
git clone --branch main https://github.com/AlanNiew/agnes-video-console.git ~/ai-video/app
bash ~/ai-video/app/deploy/bootstrap-server.sh
```

脚本（`deploy/bootstrap-server.sh`，幂等，可重复执行）会：建目录 → clone/pull → `npm ci` → `npm run build`
→ 装并启动 systemd **用户**服务 → 健康检查 → 打印还需你手动做的 sudo 清单。

```bash
systemctl --user status agnes-console --no-pager     # active (running)
journalctl --user -u agnes-console -n 40 --no-pager  # 启动横幅 + 数据库路径
curl -s http://127.0.0.1:8273/api/health             # {"app":…,"uptime_s":…}
```

### 第 3 步 · 数据库迁入 + 路径改写（关键步）

```bash
# 3.1 放库（bootstrap 若已自动放入 incoming 里的快照则可跳过）
cp ~/ai-video/incoming/agnes-console-snapshot.db ~/ai-video/data/agnes-console.db
chmod 600 ~/ai-video/data/agnes-console.db          # 库里有 API Key

cd ~/ai-video/app
# 3.2 先看库里的失效前缀分布
node tools/db-relocate.js --db ~/ai-video/data/agnes-console.db --mode report
```

实测本机库的 report 输出（供对照）：

```
tasks.video_local_path（759 行非空）      759  D:/Programing/AI_Video_Create/agnes-video-console
project_images.local_path（173 行非空）   171  D:/Programing/AI_Video_Create/agnes-video-console
project_tts.local_path（348 行非空）      348  D:/Programing/AI_Video_Create/agnes-video-console
projects.bgm（30 行，含 30 个 Windows 路径字符串）
settings.value（21 行；其中 12 个 D:/… 路径 + 15 个远端 URL）
```

```bash
# 3.3 dry-run（★ 必须给两个 --from：第二个是 v2.2 写歪 bug 遗留的 lib\data 前缀，146 行）
node tools/db-relocate.js --db ~/ai-video/data/agnes-console.db \
  --from 'D:\Programing\AI_Video_Create\agnes-video-console\data' \
  --from 'D:\Programing\AI_Video_Create\agnes-video-console\lib\data' \
  --to '/home/alan/ai-video/data'
# 期望：759 / 171 / 348 / 30 / 1 行，合计 1309 行
# 3.4 确认后写库（工具会做复核：残留 Windows 路径应为 0）
... --apply
node tools/db-snapshot.js --db ~/ai-video/data/agnes-console.db   # 改完立刻留一份
systemctl --user restart agnes-console
```

**为什么用 `rewrite` 而不是 `clear-missing`**：
`tasks.video_local_path` 一旦置空，poller 启动时会触发「历史归档补扫」，把 **759 条历史任务**挨个重新下载
（500 ms 限速，且远端链接多已过期）——纯浪费。保留非空路径即可完全避开，代价只是历史项目的本地素材是"悬空路径"。

**改写后的效果**：路径形如 `/home/alan/ai-video/data/artifacts/a1789….mp4`。
文件不在不影响新集生产；想救活历史项目见第 9 节 B+。

### 第 4 步 · 按服务器现实调设置

```bash
curl -s -X PUT http://127.0.0.1:8273/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"fish_api_key":"","music_api_base":"http://127.0.0.1:15001",
       "dreamina_auto_character":false,"video_auto_download":true}'
```

| 设置                      | 改成                     | 为什么                                                                                                                                                                 |
| ------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fish_api_key`            | `""`（清空）             | 服务器到 `api.fish.audio` 实测超时。不清空时**全自动成片的每个镜头都要白等一次超时**；清空后 `workers/auto.js` 直接判定「未配置 Fish Audio Key，跳过配音」走向下一阶段 |
| `music_api_base`          | `http://127.0.0.1:15001` | 服务器本机就跑着 netmusic 容器（本机原来是绕公网 IP 访问它），换成回环更快更稳                                                                                         |
| `dreamina_auto_character` | `false`                  | 服务器没装即梦 CLI，关掉可省掉每集一次探测+回退（功能等价：v2.6.1 本来也会回退到 Agnes 免费档）                                                                        |
| `video_auto_download`     | `true`                   | 保持开启：新集镜头视频必须落本地，渲染才拿得到素材                                                                                                                     |

> ⚠ 布尔字段必须传 JSON 布尔值。传字符串 `"0"` 会被当 truthy 从而**打开**该功能（`routes/settings.js` 的 `b.x ? '1' : '0'`）。
> 修改后核对：`curl -s http://127.0.0.1:8273/api/settings`。

### 第 5 步 · 装中文字体（唯一必须的 sudo 依赖）

```bash
sudo apt-get update && sudo apt-get install -y fonts-noto-cjk fonts-wqy-microhei
# 校验渲染 worker 认的绝对路径
ls -l /usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc \
      /usr/share/fonts/truetype/wqy/wqy-microhei.ttc
```

`workers/render.js` 的 `findFont()` / `findSerifFont()` 只认固定绝对路径（Windows `C:/Windows/Fonts/*`
与 Linux 的 noto/wqy 三处），找不到就**静默跳过**片头/片尾卡文字 —— 除脚本报错外没有任何提示，务必装。

### 第 6 步 · 公网入口（二选一）

#### 6A 自建 nginx 8443 + Basic Auth + acme.sh（不依赖第三方，推荐）

模板已就绪并**在本机对服务器那台 nginx 1.24.0 实跑过 `nginx -t`，语法通过**：
`deploy/nginx-agnes.conf`。

```bash
# ① 证书（DNS-01，不需要占用 80 端口；未备案域名也照签）
curl https://get.acme.sh | sh -s email=<你的邮箱>
ls ~/.acme.sh/dnsapi/ | grep -E 'dp|ali|cf|huawei'   # 按你的 DNS 商选 plugin
export DP_Id='<DNSPod ID>'; export DP_Key='<DNSPod Token>'      # 阿里云用 Ali_Key/Ali_Secret，Cloudflare 用 CF_Token
~/.acme.sh/acme.sh --issue --dns dns_dp -d <域名>
sudo mkdir -p /usr/local/nginx/certs
~/.acme.sh/acme.sh --install-cert -d <域名> \
  --key-file /tmp/agnes.key --fullchain-file /tmp/agnes.fullchain.pem \
  --reloadcmd "sudo install -m600 /tmp/agnes.key /usr/local/nginx/certs/agnes.key && \
               sudo install -m644 /tmp/agnes.fullchain.pem /usr/local/nginx/certs/agnes.fullchain.pem && \
               sudo /usr/local/nginx/sbin/nginx -s reload"
# （acme.sh 自建续期 cron；DNS 商无 API 时用 `--issue --dns -d <域名>` 手动加 TXT，但需手动续期）

# ② Basic Auth 账号（-B = bcrypt）
sudo apt-get install -y apache2-utils
sudo htpasswd -cB /usr/local/nginx/conf/htpasswd-agnes alan     # 交互输入强密码

# ③ 落 server 块并热加载
sudo cp ~/ai-video/app/deploy/nginx-agnes.conf /usr/local/nginx/conf/conf.d/agnes.conf
sudo sed -i 's/<你的域名>/<域名>/' /usr/local/nginx/conf/conf.d/agnes.conf
sudo /usr/local/nginx/sbin/nginx -t && sudo /usr/local/nginx/sbin/nginx -s reload

# ④ 放行端口（两处都要做！）
sudo ufw allow 8443/tcp                        # 服务器 UFW 实测 ENABLED
# 云控制台 → 安全组 → 入方向放行 8443/TCP       # 华为云必须做，否则外网仍不通

# ⑤ DNS：A 记录 <域名> → 服务器公网 IP
```

模板里已包含的关键设置：`auth_basic` 全站鉴权、`proxy_buffering off`（大文件流式）、
显式透传 `Range`/`If-Range`（成片拖动进度条靠 206 分段）、600 s 超时、`client_max_body_size 8m`。
**注意**：这台 nginx **没编译 http_v2 模块**，所以模板特意不写 `http2 on;` / `listen … http2`（写了会启动失败）。

**为什么用 8443**：大陆云主机上未备案域名的 80/443 会被拦；非标端口不受影响。
如果域名已备案，把 `listen 8443 ssl;` 改成 `listen 443 ssl;` 并对应放行 443 即可。

#### 6B Cloudflare Tunnel（零 sudo、零端口放行、零备案问题）

适用于：域名 DNS 能托管到 Cloudflare。服务器只做出站连接，**不开放任何入站端口**。

```bash
mkdir -p ~/bin && cd ~/bin
curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared
./cloudflared tunnel login                 # 输出 URL 到浏览器授权
./cloudflared tunnel create agnes
./cloudflared tunnel route dns agnes <域名>
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: agnes
credentials-file: /home/alan/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: <域名>
    service: http://127.0.0.1:8273
  - service: http_status:404
EOF
# 装成用户服务（同样不需要 sudo）
./cloudflared service install            # 若提示需要 root，则手写 ~/.config/systemd/user/cloudflared.service
systemctl --user enable --now cloudflared
```

鉴权用 **Cloudflare Access**（Zero Trust 免费档，邮箱 OTP 策略绑到该 hostname），
不需要再叠 nginx Basic Auth。

#### 6C 都不要（临时/最保守）

```powershell
ssh -L 8273:127.0.0.1:8273 <ssh别名>     # 然后浏览器开 http://127.0.0.1:8273
```

### 第 7 步 · 验收清单

```bash
cd ~/ai-video/app && node tools/preflight.js
```

| 检查                            | 期望                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| `/api/health`                   | 200 JSON                                                                   |
| preflight：ffmpeg / ffprobe     | ✅                                                                         |
| preflight：中文字体             | ✅（第 5 步之后）                                                          |
| preflight：数据目录 / 磁盘      | ✅ / 约 19 GB                                                              |
| preflight：Agnes API Key        | ✅（随库迁来，无需重填）                                                   |
| preflight：**Fish API Key**     | ❌ 报「未配置」—— **这是本方案的预期状态**（配音已停用），不是故障         |
| preflight：**Fish 代理**        | ⚠️ 未注入 —— 同样预期                                                      |
| preflight：CDN 速率             | ✅/⚠️ 视网络；实测服务器直连 Agnes CDN 0.8–1.1 MB/s                        |
| 浏览器 `https://<域名>:8443`    | 弹 Basic Auth → 登录后进控制台                                             |
| 「🏆 我的作品」                 | **空**（未迁 works，预期）                                                 |
| 真跑一集短片（新集第 1 镜即可） | 提交 → 轮询 → 归档 → 渲染 → 可下载成片                                     |
| ↳ 片头/片尾卡中文               | 正常显示（字体验收点）                                                     |
| ↳ 成片拖进度条                  | 能拖（nginx Range 透传验收点）                                             |
| ↳ 成片内容                      | **无旁白、字幕是分镜脚本原文**（TTS 停用的必然结果）                       |
| 渲染期内存                      | `free -m` 观察；`journalctl --user -u agnes-console \| grep -i oom` 无输出 |

### 第 8 步 · 日常运维

```bash
# 更新代码
cd ~/ai-video/app && git pull && npm ci --no-audit --no-fund && npm run build
systemctl --user restart agnes-console
# 或者直接重跑引导（幂等）：bash ~/ai-video/app/deploy/bootstrap-server.sh

# 服务
systemctl --user status agnes-console
journalctl --user -u agnes-console -f          # 实时日志（内存环形日志也在页面「日志」面板）

# 每日库备份（用户 crontab -e；.backup 对在线 WAL 库安全）
15 4 * * * sqlite3 /home/alan/ai-video/data/agnes-console.db ".backup '/home/alan/ai-video/backup/agnes-$(date +\%F).db'" && find /home/alan/ai-video/backup -name 'agnes-*.db' -mtime +14 -delete

# 磁盘水位
df -h / ; du -sh ~/ai-video/data/*             # 实测约 0.6 GB/集（镜头素材 ~0.36 + 成片 ~0.28）
```

**回滚**：`systemctl --user stop agnes-console` → `cp ~/ai-video/backup/agnes-<日期>.db ~/ai-video/data/agnes-console.db`
→ `git checkout <上一个提交> && npm ci && npm run build` → `systemctl --user start agnes-console`。

## 4. 风险与对策

| 风险                                         | 影响                                     | 对策                                                                             |
| -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| 控制台**零鉴权**且库内存着 API Key           | 任何人可读改设置、烧你的额度             | 只经 HTTPS + Basic Auth 暴露；可选再叠 IP 白名单；**绝不**把 8273 直接对外       |
| 18293 上传服务是公开直链（既有，非本次引入） | 有链接即可下载                           | 继续只放封面/素材，勿放敏感内容                                                  |
| 未备案域名跑 80/443                          | 被运营商拦                               | 用 8443；或走 6B Cloudflare Tunnel                                               |
| 磁盘 19 GB / 内存 1.7 GB                     | 攒到 ~30 集后吃紧；渲染峰值可能被 OOM 杀 | 盯水位与 OOM 日志；渲染串行；及时清理 artifacts 或扩盘                           |
| 服务器无配音                                 | 成片无旁白（字幕仍在）                   | 配音回本机补：本机跑配音 → 把音频与项目配置同步回来；或第 9 节给服务器出口       |
| 两台机器数据分叉（本方案天然如此）           | 本机有历史库、服务器有新库               | 明确「服务器=生产、本机=历史+配音工作台」；需要合并不手动拼库，走发布包/素材搬运 |
| 更新重启打断在途轮询                         | 少数任务延迟                             | poller 有退避与自愈；尽量在空闲时更新                                            |
| 历史任务/项目在服务器上点开是坏图坏视频      | 观感差（路径已改为不存在的 Linux 路径）  | 预期内；第 9 节 B+ 可一次性救活（627 MB / 2.46 GB 两档）                         |

## 5. 本方案交付的文件

| 文件                           | 作用                                                        | 验证情况                                                                                  |
| ------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `deploy/bootstrap-server.sh`   | 服务器侧幂等引导（clone→依赖→构建→systemd→健康检查）        | 服务器上 `bash -n` 通过                                                                   |
| `deploy/agnes-console.service` | systemd **用户**服务模板（占位符由脚本替换）                | 服务器上 `systemd-analyze --user verify` 无告警                                           |
| `deploy/nginx-agnes.conf`      | 8443 + TLS + Basic Auth + Range 透传反代模板                | 在服务器 nginx 1.24.0 上 `nginx -t` **通过**                                              |
| `tools/db-snapshot.js`         | 跨 WAL 一致性快照（`VACUUM INTO` + 完整性校验）             | 本机对真实库跑通，integrity_check ok                                                      |
| `tools/db-relocate.js`         | 库内绝对路径 report/rewrite/clear-missing/**assets** 四模式 | 本机对真实库副本跑通：1309 行改写、0 残留、JSON 解析无损、assets 466 文件/627 MB 实拷一致 |
| `docs/DEPLOY_SELF_HOSTED.md`   | 本文                                                        | —                                                                                         |

## 6. 可选升级路线（按需，不在本次范围）

1. **B+：补传「库里被引用的产物」**（性价比最高，实测数据说话）

   ```powershell
   # 本机（Windows）
   cd D:\Programing\AI_Video_Create\agnes-video-console
   node tools/db-relocate.js --mode assets --out ..\.scratch\assets                 # 466 文件 / 627 MB
   node tools/db-relocate.js --mode assets --out ..\.scratch\assets --include-videos # 1108 文件 / 2.46 GB
   node tools/db-relocate.js --mode assets --out ..\.scratch\assets --apply
   scp -r ..\.scratch\assets\* <ssh别名>:~/ai-video/data/artifacts/
   ```

   库内路径第 3 步已改好，文件到位即生效：角色库 12 张图、BGM 缓存、逐镜配音、项目图片全部可用；
   带 `--include-videos` 时**历史项目也能重渲**。对比一下：全量 data/ 是 21.2 GB，而"被引用的产物"只有 627 MB～2.46 GB。

2. **迁成片作品库**（works 9.2 GB）：`rsync -av --info=progress2` 过去，服务器即可直接播放/下载历史成片。
3. **服务器配音**：给服务器一条可用出口（现有 ss-local → 47.83.12.16 对 fish.audio 不通），
   写 `~/ai-video/agnes-console.env` 里的 `FISH_PROXY=127.0.0.1:<端口>`，再回填 `fish_api_key` 即可。
4. **即梦 CLI**：装 CLI + **手动**登录（官方明确「不要通过 Agent 完成登录」），再把 `dreamina_auto_character` 打开。
5. **扩盘**：华为云 EVS 扩容后可全量迁 works + artifacts，服务器成为唯一生产机。
6. **preflight 的"配音已停用"红项**：可给 `tools/preflight.js` 加一个「TTS 已按设计停用」的判定，
   让预检在这种部署形态下不再报 ❌（小改动，需要时再做）。
