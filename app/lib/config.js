'use strict';

/**
 * 全部配置都来自环境变量，没有一处硬编码路径。
 * Docker 里通过 -e 或 env_file 注入，本地直接跑也没问题（有默认值）。
 */
const path = require('path');

function env(key, def) {
  const v = process.env[key];
  return (v === undefined || v === '') ? def : v;
}
function envInt(key, def) {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : def;
}
function envBool(key, def) {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

const config = {
  // 服务端口
  port: envInt('PORT', 8420),
  // 监听地址，容器里要 0.0.0.0，本机调试可设 127.0.0.1
  host: env('HOST', '0.0.0.0'),
  // 监控录像根目录（挂载进容器的路径）
  watchDir: path.resolve(env('WATCH_DIR', '/media/rec')),
  // 索引与缩略图缓存目录
  dataDir: path.resolve(env('DATA_DIR', '/data')),
  // 只索引指定设备 ID，留空则自动发现全部
  device: env('DEVICE', ''),
  // 增量扫描间隔（分钟）
  scanInterval: envInt('SCAN_INTERVAL', 5),
  // 同时扫描的目录数。串行扫一个目录要等一串 stat/open，并行能快 3-4 倍；
  // 走网络挂载时这个值还受链路带宽约束，本地盘可以再开大些
  scanConcurrency: envInt('SCAN_CONCURRENCY', 4),
  // 往下钻几层找 mp4。不假设目录命名，只限制深度，防止在奇怪的挂载点上无限递归
  scanDepth: envInt('SCAN_DEPTH', 4),
  // 单个目录内同时探测的文件数
  fileConcurrency: envInt('FILE_CONCURRENCY', 8),
  // 启动时是否立刻全量扫描一次
  scanOnBoot: envBool('SCAN_ON_BOOT', true),
  // 是否读取 mp4 头部拿真实时长（关掉则一律按 SEGMENT_DURATION 算）
  probeDuration: envBool('PROBE_DURATION', true),
  // 探测失败时的兜底时长（秒）
  segmentDuration: envInt('SEGMENT_DURATION', 60),
  // 缩略图：ffmpeg 可执行文件，置空则不生成缩略图
  ffmpeg: env('FFMPEG', 'ffmpeg'),
  // 缩略图缓存上限（MB），超了不再生成
  thumbCacheMaxMB: envInt('THUMB_CACHE_MAX_MB', 512),
  // 事件段合并阈值（秒），前端可覆盖
  gapThreshold: envInt('GAP_THRESHOLD', 300),
  // 时区，Docker 里设 TZ
  tz: env('TZ', 'Asia/Shanghai'),
};

config.indexFile = path.join(config.dataDir, 'index.json');
config.thumbDir = path.join(config.dataDir, 'thumbs');

module.exports = config;
