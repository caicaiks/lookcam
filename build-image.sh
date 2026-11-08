#!/usr/bin/env bash
#
# 在本机构建 lookcam 镜像，导成可以直接传到 NAS 的 tar.gz。
#
# 为什么不用 docker compose build：
#   Mac（尤其 Apple Silicon）是 arm64，绝大多数 NAS 是 x86_64。
#   按本机架构构建出来的镜像拷到 NAS 上跑，会直接报
#     exec /usr/local/bin/node: exec format error
#   所以这里固定用 buildx 构建「目标架构」的镜像，和本机架构无关。
#
# 用法：
#   ./build-image.sh                          # 默认 linux/amd64，打最新代码
#   TARGET=linux/arm64 ./build-image.sh       # NAS 是 ARM 的话
#   TAG=1.0.0 ./build-image.sh                # 打版本号
#
# 前置条件：
#   1. 本机有可用的 Docker 引擎（Docker Desktop / OrbStack / colima 任一）
#   2. 有 buildx：docker buildx version
#   3. 能跑 amd64 的模拟层（跨架构构建需要）：
#        docker run --privileged --rm tonistiigi/binfmt --install amd64
#      报 exec format error 时先跑上面这条。

set -euo pipefail
cd "$(dirname "$0")"

TARGET="${TARGET:-linux/amd64}"
TAG="${TAG:-latest}"
IMAGE="lookcam:${TAG}"
ARCH_SLUG="$(echo "$TARGET" | tr '/' '-')"
OUT="lookcam-${ARCH_SLUG}.tar.gz"

say() { printf '\033[36m[build]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 前置检查 ----------

command -v docker >/dev/null || die "找不到 docker 命令"
docker info >/dev/null 2>&1 || die "连不上 Docker 引擎。先启动 Docker Desktop / OrbStack / colima，再跑一次"
docker buildx version >/dev/null 2>&1 || die "没有 buildx 插件。Docker Desktop 自带；用 colima 的话：brew install docker-buildx"

HOST_ARCH="$(uname -m)"
say "本机 ${HOST_ARCH} → 目标 ${TARGET}（跨架构构建会慢一些，属正常）"

# ---------- 构建 ----------

say "构建 ${IMAGE} ..."
docker buildx build \
  --platform "$TARGET" \
  -t "$IMAGE" \
  --load \
  ./app

# 构建完立刻核对架构，别等传到 NAS 上才发现打反了
GOT="$(docker image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')"
[ "$GOT" = "$TARGET" ] || die "镜像架构是 ${GOT}，期望 ${TARGET}"
say "架构核对通过：${GOT}"

# ---------- 导出 ----------

say "导出到 ${OUT} ..."
docker save "$IMAGE" | gzip -9 > "$OUT"
SIZE="$(du -h "$OUT" | cut -f1)"
say "完成：${OUT}（${SIZE}）"

cat <<TIPS

下一步（把 <NAS> 换成你的 NAS 地址）：

  1. 传上去
       scp ${OUT} <NAS>:/volume1/docker/

  2. 在 NAS 上导入
       ssh <NAS> 'docker load < /volume1/docker/${OUT}'

  3. 启动，注意要 --no-build
       cd <你的 docker-compose.yml 所在目录>
       docker compose up -d --no-build

  --no-build 是必须的：不加的话 compose 看到 build: 段落会尝试在本机重新构建，
  而 NAS 上既没有源码也不一定有网络。

  以后代码改了要更新：重跑本脚本 → 重复 1~3。

  如果你用了 TAG=<版本号>，记得把 docker-compose.yml 里的
  image: lookcam:${TAG} 改成同一个名字，否则 compose 找不到镜像。
TIPS
