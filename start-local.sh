#!/usr/bin/env bash
#
# 本地直接跑（不经 Docker）
#
#   ./start-local.sh                            用 settings.json 里存过的监控目录
#   WATCH_DIR=/你的/录像目录 ./start-local.sh      临时指定
#   PORT=9000 ./start-local.sh                  换端口
#
# 这个脚本不含任何预设路径。陌生人 clone 下来先带一次 WATCH_DIR，
# 之后在「设置 → 监控目录」里改，值会存进 data/settings.json，脚本自己读。
#
set -euo pipefail
cd "$(dirname "$0")"

export DATA_DIR="${DATA_DIR:-$(pwd)/data}"
export PORT="${PORT:-8420}"
export TZ="${TZ:-Asia/Shanghai}"

mkdir -p "$DATA_DIR"

# 读 settings.json 里的某一项。用 node 是因为它本来就是唯一依赖，
# 不去赌系统里装没装 jq。
read_setting() {
  node -e '
    try {
      const fs = require("fs");
      const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    } catch { /* 文件不存在或不是合法 JSON，当作没设过 */ }
  ' "$DATA_DIR/settings.json" "$1" 2>/dev/null || true
}

# ---- 监控目录：settings.json > 环境变量 > 报错 ----
# 顺序跟服务端保持一致：settings.json 是覆盖项，用户在界面上改过就以它为准
env_watch="${WATCH_DIR:-}"
saved="$(read_setting watchDir)"
if [ -n "$saved" ]; then
  WATCH_DIR="$saved"
  WATCH_SRC="data/settings.json"
  # 故意不 export：服务端自己会从 settings.json 读这个值。
  # 再从环境变量塞一遍，它就会把同一路径当成「环境变量默认值」，
  # 设置页里那条「已修改」标记会消失，点「重置」也变成空操作。
  WATCH_EXPORT=0
  # 环境变量指了别的目录却被覆盖，必须说出来，不能装作没看见
  if [ -n "$env_watch" ] && [ "$env_watch" != "$saved" ]; then
    WATCH_SHADOWED="$env_watch"
  fi
elif [ -n "$env_watch" ]; then
  WATCH_DIR="$env_watch"
  WATCH_SRC="环境变量"
  WATCH_EXPORT=1
else
  cat <<'EOF'
没有指定监控目录。

  WATCH_DIR="/你的/录像目录" ./start-local.sh

带一次之后，进「设置 → 监控目录」保存，下次直接 ./start-local.sh 就行
—— 脚本读的是 data/settings.json，不用再传环境变量。

注意要指到 xiaomi_camera_videos 这一层，它下面才是「设备ID/日期小时」目录。
EOF
  exit 1
fi

if [ ! -d "$WATCH_DIR" ]; then
  echo "监控目录不存在：$WATCH_DIR"
  echo "（来源：$WATCH_SRC）"
  echo
  echo "共享盘先在系统里连上；路径填错了就去「设置 → 监控目录」改。"
  exit 1
fi

if [ "$WATCH_EXPORT" = "1" ]; then
  export WATCH_DIR
fi

# 端口同理：设置页里改过就以它为准。这里只用来打印访问地址，不回灌环境变量
# （回灌会让服务端把它当成默认值，设置页的「已修改」标记就没了）
display_port="$PORT"
saved_port="$(read_setting port)"
if [ -n "$saved_port" ]; then
  display_port="$saved_port"
  PORT_SRC="data/settings.json"
else
  PORT_SRC="环境变量 / 默认值"
fi

echo "  监控目录  $WATCH_DIR"
echo "            ↳ $WATCH_SRC"
if [ -n "${WATCH_SHADOWED:-}" ]; then
  echo
  echo "  ! 环境变量 WATCH_DIR=$WATCH_SHADOWED 没有生效，被上面这个覆盖了。"
  echo "    要改用环境变量，先去「设置 → 监控目录」点「重置」。"
fi
echo "  数据目录  $DATA_DIR"
echo "  端口      $display_port   ↳ $PORT_SRC"
echo "  时区      $TZ"
echo
echo "  其他配置（扫描间隔、并发数等）在页面「设置」里改，即时生效"
echo "  打开 http://127.0.0.1:${display_port}     Ctrl+C 停止"
echo

exec node app/server.js
