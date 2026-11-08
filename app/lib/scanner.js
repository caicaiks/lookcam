'use strict';

/**
 * 扫描监控目录，产出片段元数据。
 *
 * 这里刻意不假设目录长什么样：**目录只是「扫描单元」，时间来自片段自己**。
 *
 * 原来那层 YYYYMMDDHH 目录对时间而言是冗余的 —— 文件名里的时间戳已经是绝对时间，
 * 目录名只是它的一个更粗的副本。所以时间一律从片段推，目录只剩下唯一的不可替代
 * 作用：作为增量扫描的最小单位（不用每轮把所有文件重新 stat 一遍）。
 *
 * 时间戳解析顺序（命中即止）：
 *   1. 文件名尾部的 10 位 Unix 秒    小米：54M50S_1793908490.mp4
 *   2. 文件名里嵌的 YYYYMMDDHHMMSS   通用：20261108171234.mp4 / 2026-11-08_17-12-34.mp4
 *   3. 目录名的 YYYYMMDD[HH] + 文件名前缀 MMmSSs
 *   4. 文件 mtime                    最后的兜底：命名完全不带时间的情况
 *
 * 四种都推不出来的文件会被跳过（不猜），计数写进日志，免得时间轴被错误日期污染。
 */

const fs = require('fs/promises');
const path = require('path');
const { probe } = require('./mp4');

const MP4 = /\.mp4$/i;
/** 尾部 10 位 Unix 秒 —— 小米的 54M50S_1793908490.mp4 */
const TS_TAIL = /_(\d{10})\.mp4$/i;
/** 嵌在名字里的日历时间，允许 , - _ . 空格 : T 作为分隔 */
const TS_EMBED = /(20\d{2})[-_.\s]?(\d{2})[-_.\s]?(\d{2})[-_.T\s]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})/;
/** 小米的文件名前缀：本次录制在该小时内的起点（分:秒），不是时长 */
const PREFIX_MS = /^(\d{1,2})M(\d{1,2})S(?:_|\.|$)/i;

/** 1990 ~ 2100 之外的时间戳一律当解析失败，避免把 0 或乱码当成 1970 */
function plausible(sec) {
  return Number.isFinite(sec) && sec > 631152000 && sec < 4102444800;
}

/** 用本地时区构造，返回 Unix 秒；分量越界（比如 13 月）返回 0 */
function localTs(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return 0;
  const dt = new Date(y, mo - 1, d, h, mi, s, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return 0;
  return Math.floor(dt.getTime() / 1000);
}

/**
 * 从相对路径里认日期。只看最后两段 —— 再往深就没法无歧义地判断哪一段是日期了。
 * 认得出返回 { day:'YYYYMMDD', hour, hasHour }。
 */
function dirDate(rel) {
  if (!rel) return null;
  const parts = rel.split('/');
  for (let i = parts.length - 1; i >= 0 && i >= parts.length - 2; i--) {
    const digits = parts[i].replace(/\D/g, '');
    // 10 位 = YYYYMMDDHH，8 位 = YYYYMMDD；其余长度不认
    // 设备 ID 之类的纯数字串会落到这里，靠年份范围挡掉
    const len = digits.length;
    if (len !== 10 && len !== 8) continue;
    const y = Number(digits.slice(0, 4));
    if (y < 1990 || y > 2100) continue;
    const mo = Number(digits.slice(4, 6));
    const d = Number(digits.slice(6, 8));
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const hasHour = len === 10;
    const h = hasHour ? Number(digits.slice(8, 10)) : 0;
    if (h > 23) continue;
    return { day: digits.slice(0, 8), hour: h, hasHour, y, mo, d };
  }
  return null;
}

/** 目录名里能看出是哪天就返回 'YYYYMMDD'，看不出返回 ''（增量扫描要用） */
function dayFromName(rel) {
  const d = dirDate(rel);
  return d ? d.day : '';
}

/**
 * 推一个片段的起始时间。
 * @returns {{ ts:number, src:'name'|'dir'|'mtime' } | null}
 */
function resolveTs(name, rel, mtimeMs) {
  const tail = TS_TAIL.exec(name);
  if (tail) {
    const ts = Number(tail[1]);
    if (plausible(ts)) return { ts, src: 'name' };
  }

  const emb = TS_EMBED.exec(name);
  if (emb) {
    const ts = localTs(+emb[1], +emb[2], +emb[3], +emb[4], +emb[5], +emb[6]);
    if (plausible(ts)) return { ts, src: 'name' };
  }

  const d = dirDate(rel);
  if (d) {
    // 前缀是「该小时内的分:秒」，所以统一按分钟+秒加到目录时间上
    const pre = PREFIX_MS.exec(name);
    const mm = pre ? +pre[1] : 0;
    const ss = pre ? +pre[2] : 0;
    const ts = localTs(d.y, d.mo, d.d, d.hour, mm, ss);
    if (plausible(ts)) return { ts, src: 'dir' };
  }

  if (mtimeMs) {
    const ts = Math.floor(mtimeMs / 1000);
    if (plausible(ts)) return { ts, src: 'mtime' };
  }

  return null;
}

function hasClip(entries) {
  return entries.some((e) => e.isFile() && !e.name.startsWith('.') && MP4.test(e.name));
}

/**
 * 列出所有「装着 mp4 的目录」。
 * 不限定命名、不限定层级（深度由 cfg.scanDepth 控制，默认 4 层）。
 */
async function listDirs(cfg) {
  const maxDepth = Number.isFinite(cfg.scanDepth) ? Math.max(0, cfg.scanDepth) : 4;
  const out = [];

  async function walk(abs, rel, depth) {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (e) {
      // 根目录读不了是致命错误（多半是挂载点没起来），要让人看见
      if (depth === 0) throw new Error(`无法读取 WATCH_DIR (${abs}): ${e.message}`);
      return; // 子目录权限不够就跳过，别让整次扫描失败
    }

    if (hasClip(entries)) {
      const dayHint = dayFromName(rel);
      // 名字里能看出日期就不用 stat；看不出才取 mtime 给增量扫描做判断
      let mtimeMs = 0;
      if (!dayHint) {
        try {
          mtimeMs = (await fs.stat(abs)).mtimeMs;
        } catch {
          /* 拿不到 mtime 就当它没变过，下一轮再说 */
        }
      }
      out.push({ rel, abs, dayHint, mtimeMs });
    }

    if (depth >= maxDepth) return;
    for (const e of entries) {
      // withFileTypes 下符号链接的 isDirectory() 是 false，天然挡住了环
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (depth === 0 && cfg.device && e.name !== cfg.device) continue;
      await walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  }

  await walk(cfg.watchDir, '', 0);
  return out;
}

/** 批量并发，避免一次性打开几千个文件句柄 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 扫一个目录。
 * @param cfg 配置
 * @param info listDirs 返回的项
 * @param known Map<文件名, 旧片段> 用来复用已探测过的时长，避免重复读文件头
 * @returns {{ segs:any[], sources:Record<string,number> }}
 */
async function scanDir(cfg, info, known) {
  const abs = info.abs;
  let names;
  try {
    names = await fs.readdir(abs);
  } catch {
    return { segs: [], sources: {} };
  }

  const candidates = names.filter((n) => !n.startsWith('.') && MP4.test(n));
  const sources = { name: 0, dir: 0, mtime: 0, dropped: 0 };

  const segs = await mapLimit(candidates, Math.max(1, cfg.fileConcurrency || 8), async (name) => {
    const full = path.join(abs, name);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;

    const t = resolveTs(name, info.rel, st.mtimeMs);
    if (!t) {
      sources.dropped++;
      return null;
    }
    sources[t.src]++;

    const prev = known && known.get(name);
    // 复用条件：文件大小没变，且有上次探测的时长。
    // 如果开了探测但上次没拿到分辨率，就再试一次（老索引补数据）。
    const canReuse = prev && prev.size === st.size && prev.dur && (!cfg.probeDuration || prev.width);
    let dur, width, height;
    if (canReuse) {
      dur = prev.dur;
      width = prev.width;
      height = prev.height;
    } else if (cfg.probeDuration) {
      const r = await probe(full);
      dur = r && r.duration > 0 ? r.duration : cfg.segmentDuration;
      width = r && r.width;
      height = r && r.height;
    } else {
      dur = cfg.segmentDuration;
    }

    return {
      name,
      ts: t.ts,
      size: st.size,
      mtime: st.mtimeMs,
      dur,
      width,
      height,
    };
  });

  return { segs: segs.filter(Boolean).sort((a, b) => a.ts - b.ts), sources };
}

module.exports = { listDirs, scanDir, dayFromName, resolveTs, dirDate };
