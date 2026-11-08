# Lookcam · 监控回看
# 一个容器搞定：Node 服务 + ffmpeg 抽帧，零 npm 依赖

FROM node:20-alpine

ENV TZ=Asia/Shanghai \
    PORT=8420 \
    WATCH_DIR=/media/rec \
    DATA_DIR=/data

# tzdata 让日志和日期计算用北京时间；ffmpeg 用于时间轴缩略图
RUN apk add --no-cache tzdata ffmpeg \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/cache/apk/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
