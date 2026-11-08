'use strict';

// 必须在任何 require 之前定下时区，否则 Node 的日期缓存会沿用 UTC。
// 容器里 Dockerfile 也会设 TZ，这里只是兜底。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const cfg = require('./lib/config');
const settings = require('./lib/settings');
const { Store } = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const startedAt = Date.now();

function log(...args) {
  console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...args);
}

process.env.TZ = cfg.tz;

const store = new Store(cfg, log);

// ---------------- 设置生效 ----------------

let scanTimer = null;

/** 按当前配置（重新）安排定时扫描。设置页改了间隔会走这里 */
function scheduleScans() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  if (cfg.scanInterval > 0) {
    scanTimer = setInterval(() => {
      store.scan({ full: false }).catch(() => {});
    }, cfg.scanInterval * 60 * 1000);
    log(`[scan] 自动扫描：每 ${cfg.scanInterval} 分钟`);
  } else {
    log('[scan] 自动扫描已关闭（扫描间隔为 0，只在启动和手动时扫）');
  }
}

/**
 * 某些设置改完必须立刻做点事，否则界面上看着改了、实际没生效。
 * 例如换了监控目录还沿用旧索引，用户会以为改失败了。
 * 返回的 note 会原样显示在界面上，所以每句话都要说「什么时候生效」。
 */
function applySideEffects(keys) {
  if (keys.includes('scanInterval')) scheduleScans();

  const notes = [];
  let rescan = false;

  const needRescan = keys.includes('watchDir') || keys.includes('device') || keys.includes('probeDuration');
  if (needRescan) {
    setImmediate(() => store.scan({ full: true }).catch(() => {}));
    notes.push('已开始全量重扫，稍等片刻');
    rescan = true;
  }

  // 监听地址和端口是 socket 绑定后就固定了的，只能重启
  const needsRestart = keys.includes('port') || keys.includes('host');
  if (needsRestart) notes.push('重启服务后生效');

  const nextScan = keys.includes('scanConcurrency') || keys.includes('fileConcurrency');
  if (nextScan) notes.push('下次扫描生效');

  if (keys.includes('ffmpeg')) notes.push('下次生成缩略图时生效');

  return { note: notes.join('；'), rescan, restart: needsRestart };
}

// ---------------- 工具 ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** 读 JSON 请求体，带大小上限（设置项就那么几个字段，64KB 绰绰有余） */
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 把请求参数还原成磁盘上的文件路径。
 * 各段都做严格字符校验，天然挡住 ../ 之类的穿越。
 */
function resolveSegment(q) {
  const device = String(q.d || '');
  const dirName = String(q.k || '');
  const file = String(q.f || '');

  if (!/^\d{10}$/.test(dirName)) return null;
  if (device && !/^[A-Za-z0-9_-]{1,64}$/.test(device)) return null;
  if (!/^[0-9HMS]+_\d+\.mp4$/i.test(file)) return null;

  const full = path.join(cfg.watchDir, device, dirName, file);
  const normalized = path.normalize(full);
  const root = path.normalize(cfg.watchDir + path.sep);
  if (!normalized.startsWith(root)) return null;
  return normalized;
}

// ---------------- 视频流（支持 Range） ----------------

async function serveVideo(req, res, file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return sendText(res, 404, 'not found');
  }
  const size = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  let start, end;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix)) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }

  if (!Number.isFinite(start) || start >= size || start < 0) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  if (end < start) end = size - 1;

  const len = end - start + 1;
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': len,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
  });

  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  req.on('close', () => stream.destroy());
}

// ---------------- 缩略图 ----------------

let thumbBytes = 0;
let thumbChecked = false;

async function ensureThumbDir() {
  if (!thumbChecked) {
    thumbChecked = true;
    await fsp.mkdir(cfg.thumbDir, { recursive: true }).catch(() => {});
  }
}

function thumbPathFor(q) {
  const key = `${q.d || ''}|${q.k}|${q.f}`;
  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 20);
  return path.join(cfg.thumbDir, `${hash}.jpg`);
}

function runFfmpeg(file, out) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cfg.ffmpeg, [
        '-v', 'error',
        '-ss', '2',
        '-i', file,
        '-frames:v', '1',
        '-vf', 'scale=360:-2',
        '-q:v', '5',
        '-y', out,
      ], { stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 8000);
    p.on('error', () => { clearTimeout(timer); resolve(false); });
    p.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function serveThumb(req, res, file, q) {
  if (!cfg.ffmpeg) return sendText(res, 404, 'thumb disabled');
  await ensureThumbDir();
  const out = thumbPathFor(q);

  try {
    const st = await fsp.stat(out);
    if (st.size > 0) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=604800',
      });
      return fs.createReadStream(out).pipe(res);
    }
  } catch {}

  if (thumbBytes > cfg.thumbCacheMaxMB * 1024 * 1024) {
    return sendText(res, 404, 'thumb cache full');
  }

  const ok = await runFfmpeg(file, out);
  if (!ok) return sendText(res, 404, 'thumb failed');

  try {
    const st = await fsp.stat(out);
    thumbBytes += st.size;
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=604800',
    });
    fs.createReadStream(out).pipe(res);
  } catch {
    sendText(res, 404, 'thumb missing');
  }
}

// ---------------- 静态文件 ----------------

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  if (!path.normalize(full).startsWith(path.normalize(PUBLIC_DIR + path.sep))) {
    return sendText(res, 403, 'forbidden');
  }
  try {
    const st = await fsp.stat(full);
    if (!st.isFile()) return sendText(res, 404, 'not found');

    // no-cache + ETag：每次都回来问一句，没变就 304（几十字节），变了立刻拿到新的。
    // 之前给 css/js 设 max-age=3600，导致改完样式刷新还是旧界面，很难排查。
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const inm = req.headers['if-none-match'];
    if (inm && inm === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }

    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
    });
    fs.createReadStream(full).pipe(res);
  } catch {
    sendText(res, 404, 'not found');
  }
}

// ---------------- 路由 ----------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/status') {
      return sendJson(res, 200, {
        ...store.status(),
        uptime: Math.round((Date.now() - startedAt) / 1000),
        gapThreshold: cfg.gapThreshold,
        tz: cfg.tz,
        host: cfg.host,
        port: cfg.port,
      });
    }

    if (p === '/api/days') {
      return sendJson(res, 200, { days: store.listDays() });
    }

    if (p === '/api/day') {
      const date = String(url.searchParams.get('date') || '');
      if (!/^\d{8}$/.test(date)) return sendJson(res, 400, { error: 'bad date' });
      const gap = parseInt(url.searchParams.get('gap'), 10);
      const threshold = Number.isFinite(gap) && gap >= 0 ? gap : cfg.gapThreshold;
      const day = store.getDay(date, threshold);
      if (!day) return sendJson(res, 404, { error: 'no data', date });
      return sendJson(res, 200, day);
    }

    if (p === '/api/scan') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      const full = url.searchParams.get('full') === '1';
      // async=1：只负责点火，立刻返回。全量扫千余个目录要几分钟，
      // 让设置页那个「立即扫描」按钮干等五分钟是不合适的。
      if (url.searchParams.get('async') === '1') {
        store.scan({ full }).catch(() => {});
        return sendJson(res, 202, { ok: true, started: true, full });
      }
      const r = await store.scan({ full });
      return sendJson(res, 200, { ok: true, ...r });
    }

    if (p === '/api/settings') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...settings.describe(cfg) });
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET/POST only' });
      try {
        const body = await readJson(req);
        const r = await settings.apply(cfg, body);
        const effect = applySideEffects(r.applied);
        return sendJson(res, 200, { ok: true, ...r, ...effect, ...settings.describe(cfg) });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    if (p === '/api/settings/reset') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
      try {
        const body = await readJson(req);
        const key = String(body.key || '');
        const val = await settings.reset(cfg, key);
        const effect = applySideEffects([key]);
        return sendJson(res, 200, { ok: true, key, value: val, ...effect, ...settings.describe(cfg) });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    if (p === '/api/video') {
      const file = resolveSegment(Object.fromEntries(url.searchParams));
      if (!file) return sendText(res, 400, 'bad params');
      return serveVideo(req, res, file);
    }

    if (p === '/api/thumb') {
      const q = Object.fromEntries(url.searchParams);
      const file = resolveSegment(q);
      if (!file) return sendText(res, 400, 'bad params');
      return serveThumb(req, res, file, q);
    }

    if (p.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    log('[http] 处理失败', p, e.message);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

// ---------------- 启动 ----------------

async function main() {
  await fsp.mkdir(cfg.dataDir, { recursive: true }).catch((e) => {
    log(`[boot] 无法创建 DATA_DIR: ${e.message}`);
  });

  // 先让本地设置覆盖环境变量，再载入索引 —— 否则会按旧目录读一遍索引
  await settings.load(cfg);

  // 这三行必须放在 settings.load 之后：放在前面打印的是环境变量默认值，
  // 而真正生效的可能是 settings.json 里的覆盖值，日志会和时间轴对不上
  log(`[boot] 监控目录 ${cfg.watchDir}`);
  log(`[boot] 数据目录 ${cfg.dataDir}`);
  log(`[boot] 时区 ${cfg.tz}`);

  await store.load();

  // 端口现在可以在设置页里改，也就意味着有人能把服务关在自己的门外。
  // 所以绑定失败时不能只抛一个 EADDRINUSE，得告诉人该去改哪个文件。
  server.on('error', (e) => {
    log(`[boot] 监听 ${cfg.host}:${cfg.port} 失败：${e.message}`);
    log(`[boot] 改端口：编辑 ${path.join(cfg.dataDir, 'settings.json')} 里的 "port"，`);
    log('[boot] 或者临时用 PORT 环境变量覆盖，例如 PORT=8500 docker compose up -d');
    process.exit(1);
  });

  server.listen(cfg.port, cfg.host, () => {
    log(`[boot] 已启动 http://${cfg.host}:${cfg.port}`);
  });

  if (cfg.scanOnBoot) {
    store.scan({ full: Object.keys(store.dirs).length === 0 }).catch(() => {});
  }

  scheduleScans();
}

function shutdown(sig) {
  log(`[exit] 收到 ${sig}，正在保存索引…`);
  store.save().finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((e) => {
  log('[boot] 启动失败:', e.message);
  process.exit(1);
});
