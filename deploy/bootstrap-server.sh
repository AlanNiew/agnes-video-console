#!/usr/bin/env bash
# bootstrap-server.sh —— 服务器侧一键引导（**全程不需要 sudo**）
#
# 做什么：建目录 → clone/pull 代码 → npm ci → 前端构建 → 装 systemd 用户服务 → 健康检查
# 不做啥：装系统字体、开防火墙、配 nginx/证书（这些必须 sudo，见 docs/DEPLOY_SELF_HOSTED.md 第 4/5 节，
#         脚本末尾会把你需要手动跑的那几条打印出来）
#
# 用法（在服务器上，以部署用户身份）：
#   bash ~/ai-video/app/deploy/bootstrap-server.sh              # 首次：需要先把库放到 $DATA_DIR
#   APP_DIR=~/ai-video/app DATA_DIR=~/ai-video/data bash ...    # 覆盖默认路径
#   SKIP_INSTALL=1 bash deploy/bootstrap-server.sh              # 只刷新服务单元，不动依赖
#
# 幂等：重复执行 = 拉最新代码 + 重建 + 重启服务；已有的 data/ 库不会被碰。
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/ai-video/app}"
DATA_DIR="${DATA_DIR:-$HOME/ai-video/data}"
REPO="${REPO:-https://github.com/AlanNiew/agnes-video-console.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-8273}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# systemd --user 在非交互 SSH 里需要这两个变量（脚本跑在 sudo/root 下时不要用）
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

say "0/6 环境自检"
command -v node >/dev/null || { echo "✗ 缺 node（需 ≥ 22.13，本机实测 /usr/bin/node）"; exit 1; }
NODE_VER="$(node -v)"
echo "node $NODE_VER（要求 ≥ v22.13.0）"
node -e "require('node:sqlite')" 2>/dev/null || { echo "✗ node:sqlite 不可用，检查 Node 版本"; exit 1; }
echo "node:sqlite 可用"
command -v ffmpeg >/dev/null && echo "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')" || echo "⚠ 缺 ffmpeg：渲染会不可用"
systemctl --user is-system-running >/dev/null 2>&1 && echo "systemd --user 可用" || echo "⚠ systemd --user 不可用"
loginctl show-user "$(id -un)" 2>/dev/null | grep -q 'Linger=yes' && echo "Linger=yes（退出 SSH 后服务常驻）" \
  || echo "⚠ Linger 未开：需要 sudo loginctl enable-linger $(id -un)"

say "1/6 建立目录"
mkdir -p "$APP_DIR" "$DATA_DIR" "$HOME/ai-video/backup" "$HOME/ai-video/incoming" "$HOME/ai-video/logs"
printf 'APP_DIR =%s\nDATA_DIR=%s\n' "$APP_DIR" "$DATA_DIR"

say "2/6 取得代码（$BRANCH）"
# 链路说明（2026-09-23 起）：大陆机器到 github.com 的 443 **直连时好时坏**（实测过 135 s 超时）。
# 现在机器上通常已有本地出口（mihomo 127.0.0.1:7890，见 docs/DEPLOY_SELF_HOSTED.md 第 9 节），
# 于是**优先经代理拉取**（实测 fetch 0.9 s，同刻直连可能超时）。
# 仍然保持降级：代理不在或拉取失败只告警、不中断后续装服务；只有首次 clone 失败才给 bundle 方案。
GIT_PROXY=""
if ss -tln 2>/dev/null | grep -q '127\.0\.0\.1:7890'; then
  GIT_PROXY="http://127.0.0.1:7890"
  echo "  → 检测到本地出口，git 将经代理拉取（$GIT_PROXY，仅对 github.com 生效）"
fi
git_net() {
  if [ -n "$GIT_PROXY" ]; then
    git -c "http.https://github.com.proxy=$GIT_PROXY" "$@"
  else
    git "$@"
  fi
}
if [ -d "$APP_DIR/.git" ]; then
  git_net -C "$APP_DIR" fetch --prune origin || echo "⚠ fetch 失败（国际链路不稳）——沿用本地已有提交"
  git -C "$APP_DIR" checkout "$BRANCH"
  if ! git_net -C "$APP_DIR" pull --ff-only origin "$BRANCH"; then
    echo "⚠ 无法从 origin 拉取（GitHub 不可达）——继续使用当前本地提交："
    git -C "$APP_DIR" log --oneline -1
  fi
  # 把代理固化到仓库级配置，方便日后手工 git pull（代理撤掉时 git config --unset 即可）
  [ -n "$GIT_PROXY" ] && git -C "$APP_DIR" config "http.https://github.com.proxy" "$GIT_PROXY"
else
  if ! git_net clone --branch "$BRANCH" "$REPO" "$APP_DIR"; then
    cat <<'EOM'
✗ clone 失败：服务器连不上 GitHub（本环境常见）。两条路：
   A) 先装本地出口再重跑（推荐）：见 docs/DEPLOY_SELF_HOSTED.md 第 9 节（mihomo + 机场订阅）
   B) 用本机 bundle 传代码（无需 GitHub）：
    1) 本机：  cd <仓库目录> && git bundle create agnes-main.bundle main
               scp agnes-main.bundle <ssh别名>:~/ai-video/incoming/
    2) 服务器：git clone --branch main ~/ai-video/incoming/agnes-main.bundle ~/ai-video/app
               cd ~/ai-video/app && git remote set-url origin <仓库地址>
    3) 重跑本脚本
EOM
    exit 1
  fi
  [ -n "$GIT_PROXY" ] && git -C "$APP_DIR" config "http.https://github.com.proxy" "$GIT_PROXY"
fi
git -C "$APP_DIR" log --oneline -1

if [ "$SKIP_INSTALL" != "1" ]; then
  say "3/6 安装依赖 + 前端构建"
  ( cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build )
else
  say "3/6 跳过依赖安装（SKIP_INSTALL=1）"
fi

say "4/6 数据库就位检查"
if [ -f "$DATA_DIR/agnes-console.db" ]; then
  echo "已存在：$DATA_DIR/agnes-console.db"
else
  if [ -f "$HOME/ai-video/incoming/agnes-console-snapshot.db" ]; then
    cp "$HOME/ai-video/incoming/agnes-console-snapshot.db" "$DATA_DIR/agnes-console.db"
    echo "已从 incoming/agnes-console-snapshot.db 放入 data/"
  else
    echo "⚠ 尚无数据库：服务会自建一个空库（历史项目/设置都不会在）"
    echo "  迁移方式见 docs/DEPLOY_SELF_HOSTED.md 第 3 节：先把快照 scp 到 ~/ai-video/incoming/"
  fi
fi

say "5/6 安装并启动 systemd 用户服务"
mkdir -p "$HOME/.config/systemd/user"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@PORT@#$PORT#g" \
  "$APP_DIR/deploy/agnes-console.service" > "$HOME/.config/systemd/user/agnes-console.service"
systemctl --user daemon-reload
systemctl --user enable --now agnes-console.service
sleep 3
systemctl --user --no-pager --lines=0 status agnes-console.service || true

say "6/6 健康检查"
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health"; then echo; break; fi
  echo "等待服务就绪（$i/5）..."; sleep 2
done

cat <<EOF

────────────────────────────────────────────────────────────
本地回环已就绪：http://127.0.0.1:$PORT
日志：systemctl --user status agnes-console | journalctl --user -u agnes-console -f
预检：cd $APP_DIR && DATA_DIR=$DATA_DIR node tools/preflight.js
        （★ 必须带 DATA_DIR：db.js 在 import 时就会开库，漏了它会在 app/data 下建一个空库）

还需你手动执行（需要 sudo，脚本不做）：
 1) 中文字体（缺则片头/片尾卡文字静默丢失）：
    sudo apt-get update && sudo apt-get install -y fonts-noto-cjk fonts-wqy-microhei
 2) 公网入口（域名 + HTTPS + Basic Auth）：见 docs/DEPLOY_SELF_HOSTED.md 第 4 节
      sudo apt-get install -y apache2-utils
      sudo htpasswd -cB /usr/local/nginx/conf/htpasswd-agnes alan
      sudo cp $APP_DIR/deploy/nginx-agnes.conf /usr/local/nginx/conf/conf.d/agnes.conf
      # 改域名 → nginx -t → reload → ufw allow 8443/tcp → 云控制台安全组放行 8443
 3) 每日数据库备份（用户 crontab，无需 sudo）：见 runbook 第 6 节
────────────────────────────────────────────────────────────
EOF
