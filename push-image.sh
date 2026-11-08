#!/usr/bin/env bash
#
# 本机构建镜像并直接推到镜像仓库（多架构）。
#
# 和 build-image.sh 的区别：
#   build-image.sh  → 导出 tar.gz，再手动传到 NAS（不依赖任何账号）
#   push-image.sh   → 推到 GHCR / Docker Hub，NAS 上 docker compose pull 就能更新
#
# 多架构镜像没法 --load 到本地，只能直接 --push，所以这一步**必须**有仓库账号。
#
# 用法：
#   echo "<token>" | docker login ghcr.io -u <用户名> --password-stdin
#   ./push-image.sh
#
#   REGISTRY=docker.io/<你的用户名> ./push-image.sh     # 换 Docker Hub
#   PLATFORMS=linux/amd64 ./push-image.sh               # 只出 x86（更快）
#   TAG=1.0.0 ./push-image.sh
#
# GHCR 的 token 用 gh 命令行拿（需要 write:packages 权限）：
#   gh auth refresh -s write:packages
#   echo "$(gh auth token)" | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin

set -euo pipefail
cd "$(dirname "$0")"

REGISTRY="${REGISTRY:-ghcr.io/caicaiks}"
NAME="${NAME:-lookcam}"
TAG="${TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-lookcam-builder}"
IMAGE="${REGISTRY}/${NAME}:${TAG}"

say() { printf '\033[36m[push]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 前置检查 ----------

command -v docker >/dev/null || die "找不到 docker 命令"
docker info >/dev/null 2>&1 || die "连不上 Docker 引擎。先启动 Docker Desktop / OrbStack / colima"
docker buildx version >/dev/null 2>&1 || die "没有 buildx 插件。brew install docker-buildx"

# 软检查：凭证可能在 config.json，也可能放在系统钥匙串里（Docker Desktop 常见），
# 所以这里只提醒、不拦路，真没登录时 buildx 的报错本身也很明确。
CFG="${HOME}/.docker/config.json"
if [ -f "$CFG" ] && grep -qF "$REGISTRY" "$CFG"; then
  say "检测到 ${REGISTRY} 的登录凭证"
else
  say "若推送报 denied，先登录：echo \"<token>\" | docker login ${REGISTRY} -u <用户名> --password-stdin"
fi

# 跨架构构建需要 QEMU 模拟层
HOST_PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
if [ "$PLATFORMS" != "$HOST_PLATFORM" ]; then
  say "跨架构构建，安装 QEMU 模拟层 ..."
  docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null 2>&1 || true
fi

# 多平台必须走 docker-container 驱动，默认的 docker 驱动不支持一次出多个架构
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  say "创建 buildx builder: ${BUILDER}"
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
else
  docker buildx inspect "$BUILDER" --bootstrap >/dev/null
fi

say "本机 $(uname -m) → 目标 ${PLATFORMS}"
say "推送 ${IMAGE} ..."

docker buildx build \
  --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  -t "$IMAGE" \
  --push \
  ./app

cat <<TIPS

完成。镜像：${IMAGE}（${PLATFORMS}）

NAS 上拉取（在 docker-compose.yml 所在目录）：

  echo 'LOOKCAM_IMAGE=${IMAGE}' >> .env
  docker compose pull
  docker compose up -d --no-build

以后更新代码就是「重跑本脚本 → NAS 上 docker compose pull && docker compose up -d --no-build」。

注意：GHCR 的 package 默认可能不是公开的。
如果 NAS 拉取时报 denied，去 GitHub → 你的头像 → Packages → lookcam
→ Package settings → Change visibility → Public。
TIPS
