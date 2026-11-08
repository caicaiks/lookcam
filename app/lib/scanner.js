'use strict';

/**
 * 扫描监控目录，产出片段元数据。
 *
 * 目录约定（两种都支持）：
 *   <WATCH_DIR>/<设备ID>/YYYYMMDDHH/<分>M<秒>S_<unixts>.mp4
 *   <WATCH_DIR>/YYYYMMDDHH/<分>M<秒>S_<unixts>.mp4     ← 没有设备层的情况
 *
 * 文件名前缀是「该小时内的起始分:秒」，不是时长。
 * 真实时长靠读 mp4 头的 mvhd，读不到再退回配置值。
 */

const fs = require('fs/promises');
const path = require('path');
const { probe } = require('./mp4');

const DATE_DIR = /^\d{10}$/;
const SEG_NAME = /^(\d+H)?(\d+M)?(\d+S)?_(\d+)\.mp4$/i;

/** 列出所有「设备/日期小时」目录 */
async function listDirs(cfg) {
  const out = [];
  let root;
  try {
    root = await fs.readdir(cfg.watchDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`无法读取 WATCH_DIR (${cfg.watchDir}): ${e.message}`);
  }

  for (const e of root) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;

    // 情况 A：根目录下直接就是 YYYYMMDDHH
    if (DATE_DIR.test(e.name)) {
      out.push({
        device: '',
        day: e.name.slice(0, 8),
        hour: Number(e.name.slice(8, 10)),
        dirName: e.name,
        key: `_/${e.name}`,
      });
      continue;
    }

    // 情况 B：设备目录，下面再分 YYYYMMDDHH
    if (cfg.device && e.name !== cfg.device) continue;
    let sub;
    try {
      sub = await fs.readdir(path.join(cfg.watchDir, e.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sub) {
      if (!s.isDirectory() || !DATE_DIR.test(s.name)) continue;
      out.push({
        device: e.name,
        day: s.name.slice(0, 8),
        hour: Number(s.name.slice(8, 10)),
        dirName: s.name,
        key: `${e.name}/${s.name}`,
      });
    }
  }
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
 */
async function scanDir(cfg, info, known) {
  const abs = path.join(cfg.watchDir, info.device || '', info.dirName);
  let names;
  try {
    names = await fs.readdir(abs);
  } catch {
    return [];
  }

  const candidates = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.mp4')) continue;
    const m = SEG_NAME.exec(name);
    if (!m) continue;
    candidates.push({ name, ts: Number(m[4]) });
  }

  const segs = await mapLimit(candidates, Math.max(1, cfg.fileConcurrency || 8), async (c) => {
    const full = path.join(abs, c.name);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      return null;
    }

    const prev = known && known.get(c.name);
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
      name: c.name,
      ts: c.ts,
      size: st.size,
      mtime: st.mtimeMs,
      dur,
      width,
      height,
    };
  });

  return segs.filter(Boolean).sort((a, b) => a.ts - b.ts);
}

module.exports = { listDirs, scanDir };
