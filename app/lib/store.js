'use strict';

/**
 * 索引仓库：内存 Map + 落盘 JSON。
 *
 * 为什么不用 SQLite：这条数据线一年也就两三万条，
 * 全量加载进内存不到 10 MB，查询是纯内存遍历，比拉起一个数据库依赖划算得多。
 * 少一个 npm 包，Docker 镜像也少一层编译。
 */

const fs = require('fs/promises');
const path = require('path');
const { listDirs, scanDir } = require('./scanner');

const INDEX_VERSION = 1;

/** 当天 00:00 的 Unix 秒（按服务器时区，容器里是 TZ 指定的时区） */
function dayStartTs(day) {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function yesterdayStr() {
  const d = new Date(Date.now() - 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

class Store {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || console.log;
    /** @type {Record<string, {device:string,day:string,hour:number,scannedAt:number,segs:any[]}>} */
    this.dirs = {};
    this.byDay = new Map(); // day -> seg[]
    this.updatedAt = 0;
    this.scanning = false;
    this.lastScanAt = 0;
    this.lastError = '';
    this.saveTimer = null;
  }

  // ---------- 持久化 ----------

  async load() {
    try {
      const raw = await fs.readFile(this.cfg.indexFile, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.version === INDEX_VERSION && data.dirs) {
        this.dirs = data.dirs;
        this.updatedAt = data.updatedAt || 0;
        this.reindex();
        this.log(`[index] 载入 ${this.countSegments()} 条片段 / ${this.byDay.size} 天`);
      } else {
        this.log('[index] 索引版本不匹配，重新建立');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.log(`[index] 载入失败（${e.message}），将重建`);
        // 坏文件先备份，别直接覆盖掉
        await fs.rename(this.cfg.indexFile, `${this.cfg.indexFile}.bad.${Date.now()}`).catch(() => {});
      }
    }
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((e) => this.log(`[index] 保存失败: ${e.message}`));
    }, 800);
  }

  async save() {
    const payload = {
      version: INDEX_VERSION,
      updatedAt: Date.now(),
      dirs: this.dirs,
    };
    const tmp = `${this.cfg.indexFile}.tmp`;
    await fs.mkdir(this.cfg.dataDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, this.cfg.indexFile);
    this.updatedAt = payload.updatedAt;
  }

  // ---------- 内存索引 ----------

  reindex() {
    const byDay = new Map();
    for (const key of Object.keys(this.dirs)) {
      const dir = this.dirs[key];
      for (const s of dir.segs) {
        const seg = {
          device: dir.device,
          day: dir.day,
          hour: dir.hour,
          dirName: dir.day + String(dir.hour).padStart(2, '0'),
          name: s.name,
          ts: s.ts,
          size: s.size,
          dur: s.dur,
          width: s.width,
          height: s.height,
        };
        let arr = byDay.get(dir.day);
        if (!arr) byDay.set(dir.day, (arr = []));
        arr.push(seg);
      }
    }
    for (const arr of byDay.values()) arr.sort((a, b) => a.ts - b.ts);
    this.byDay = byDay;
  }

  countSegments() {
    let n = 0;
    for (const arr of this.byDay.values()) n += arr.length;
    return n;
  }

  // ---------- 扫描 ----------

  /**
   * @param {object} opts
   * @param {boolean} opts.full 忽略增量规则，全量重扫
   */
  async scan(opts = {}) {
    if (this.scanning) return { skipped: true, reason: 'scanning' };
    this.scanning = true;
    const started = Date.now();
    const full = !!opts.full;

    try {
      const dirs = await listDirs(this.cfg);
      const today = todayStr();
      const yesterday = yesterdayStr();

      // 增量策略：新目录 + 今天/昨天的目录（可能还在写入）才重扫
      const todo = dirs.filter((d) => {
        if (full) return true;
        if (d.day === today || d.day === yesterday) return true;
        return !this.dirs[d.key];
      });

      this.log(
        `[scan] ${full ? '全量' : '增量'}：共 ${dirs.length} 个目录，需扫 ${todo.length} 个`
      );

      let done = 0;
      const concurrency = Math.max(1, this.cfg.scanConcurrency || 4);
      let cursor = 0;

      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= todo.length) return;
          const info = todo[i];
          try {
            const prev = this.dirs[info.key];
            const known = new Map();
            if (prev) for (const s of prev.segs) known.set(s.name, s);

            const segs = await scanDir(this.cfg, info, known);
            this.dirs[info.key] = {
              device: info.device,
              day: info.day,
              hour: info.hour,
              scannedAt: Date.now(),
              segs: segs.map((s) => ({
                name: s.name,
                ts: s.ts,
                size: s.size,
                dur: s.dur,
                width: s.width,
                height: s.height,
              })),
            };

            if (++done % 100 === 0) this.log(`[scan] ${done}/${todo.length}`);
          } catch (e) {
            this.log(`[scan] 跳过 ${info.key}: ${e.message}`);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

      // 全量扫描时顺手清掉磁盘上已经不存在的目录记录
      if (full) {
        const alive = new Set(dirs.map((d) => d.key));
        let pruned = 0;
        for (const key of Object.keys(this.dirs)) {
          if (!alive.has(key)) {
            delete this.dirs[key];
            pruned++;
          }
        }
        if (pruned) this.log(`[scan] 清理了 ${pruned} 个已消失的目录`);
      }

      this.reindex();
      this.lastScanAt = Date.now();
      this.lastError = '';
      await this.save();

      const ms = Date.now() - started;
      this.log(
        `[scan] 完成：${done} 个目录 / ${this.countSegments()} 条片段 / ${(ms / 1000).toFixed(1)}s`
      );
      return { scanned: done, total: dirs.length, segments: this.countSegments(), ms };
    } catch (e) {
      this.lastError = e.message;
      this.log(`[scan] 失败: ${e.message}`);
      throw e;
    } finally {
      this.scanning = false;
    }
  }

  // ---------- 查询 ----------

  listDays() {
    const out = [];
    for (const [day, segs] of this.byDay) {
      const hours = new Set();
      let bytes = 0;
      let sec = 0;
      for (const s of segs) {
        hours.add(s.hour);
        bytes += s.size;
        sec += s.dur;
      }
      out.push({
        day,
        count: segs.length,
        hours: hours.size,
        bytes,
        sec: Math.round(sec),
      });
    }
    out.sort((a, b) => (a.day < b.day ? -1 : 1));
    return out;
  }

  getDay(day, gapThreshold) {
    const segs = this.byDay.get(day);
    if (!segs || !segs.length) return null;

    const base = dayStartTs(day);
    const list = segs.map((s, i) => ({
      i,
      device: s.device,
      hour: s.hour,
      name: s.name,
      ts: s.ts,
      start: Math.round(s.ts - base),
      dur: s.dur,
      size: s.size,
      width: s.width,
      height: s.height,
    }));

    // 事件段：相邻间隔 <= 阈值 视为同一次活动
    const events = [];
    let cur = null;
    for (const s of list) {
      const end = s.start + s.dur;
      if (cur && s.start - cur.end <= gapThreshold) {
        cur.end = Math.max(cur.end, end);
        cur.count++;
        cur.sec += s.dur;
      } else {
        cur = { start: s.start, end, count: 1, sec: s.dur };
        events.push(cur);
      }
    }

    const totalSec = list.reduce((a, s) => a + s.dur, 0);
    const bytes = list.reduce((a, s) => a + s.size, 0);
    const first = list[0].start;
    const last = list[list.length - 1].start + list[list.length - 1].dur;

    return {
      date: day,
      segments: list,
      events: events.map((e) => ({
        start: Math.round(e.start),
        end: Math.round(e.end),
        count: e.count,
        sec: Math.round(e.sec),
        span: Math.round(e.end - e.start),
      })),
      stats: {
        count: list.length,
        sec: Math.round(totalSec),
        bytes,
        span: Math.round(last - first),
        coverage: Math.round((totalSec / 86400) * 1000) / 10,
      },
    };
  }

  status() {
    return {
      segments: this.countSegments(),
      days: this.byDay.size,
      bytes: this.listDays().reduce((a, d) => a + d.bytes, 0),
      dirs: Object.keys(this.dirs).length,
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      watchDir: this.cfg.watchDir,
      dataDir: this.cfg.dataDir,
    };
  }
}

module.exports = { Store, dayStartTs };
