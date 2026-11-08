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
const { listDirs, scanDir, dayFromName, sigFromNames, MP4 } = require('./scanner');

/* v2：时间改为从片段自身的 ts 推（不再依赖 YYYYMMDDHH 目录名），
   dirs 的 key 从「设备/日期小时」变成「相对路径」。旧索引的 key 不可复用，直接重建。 */
const INDEX_VERSION = 2;

/** 片段 ts -> 它落在哪一天、哪个小时（按服务器时区，容器里是 TZ 指定的时区） */
function tsToDayHour(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    hour: d.getHours(),
  };
}

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

/**
 * v1 的 dirs key 是「设备/YYYYMMDDHH」，根目录直挂的情况写成「_/YYYYMMDDHH」。
 * v2 一律用真实相对路径，所以把那个占位的下划线去掉就行。
 */
function migrateV1(dirs) {
  const out = {};
  for (const key of Object.keys(dirs)) {
    const d = dirs[key] || {};
    const rel = key.startsWith('_/') ? key.slice(2) : key;
    out[rel] = { rel, scannedAt: d.scannedAt || 0, sig: '', segs: d.segs || [] };
  }
  return out;
}

class Store {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || console.log;
    /** @type {Record<string, {rel:string,scannedAt:number,sig?:string,segs:any[]}>} */
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
      } else if (data && data.version === 1 && data.dirs) {
        // v1 -> v2 只需要换 key：片段本来就带着 ts，日期和小时现在从它推，
        // 所以不用重扫、不用重新探测时长。省掉一次几分钟的全量扫描。
        this.dirs = migrateV1(data.dirs);
        this.updatedAt = data.updatedAt || 0;
        this.reindex();
        this.log(`[index] 索引已从 v1 迁移到 v2：${this.countSegments()} 条片段，无需重扫`);
        await this.save().catch((e) => this.log(`[index] 迁移后保存失败: ${e.message}`));
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
      const rel = dir.rel !== undefined ? dir.rel : key;
      for (const s of dir.segs) {
        // 日期和小时一律从片段自己的 ts 推，和它放在哪个目录里无关。
        // 这样即使某段录像被放进了错误的日期目录，时间轴也不会跟着错。
        const { day, hour } = tsToDayHour(s.ts);
        const seg = {
          dir: rel,
          hour,
          name: s.name,
          ts: s.ts,
          size: s.size,
          dur: s.dur,
          width: s.width,
          height: s.height,
        };
        let arr = byDay.get(day);
        if (!arr) byDay.set(day, (arr = []));
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

      // 增量策略（按代价从低到高）：
      //   1. 新目录 —— 一定扫
      //   2. 今天/昨天的目录 —— 可能还在写入，每轮都重扫
      //   3. 其余目录 —— 比对「目录内容指纹」，文件名列表有增删才重扫
      //
      // 指纹是 listDirs 用 readdir 顺手算出来的，不额外 stat。
      // 早期版本拿 mtime 和 scannedAt 比，那是 NAS 时钟减本机时钟，
      // 两边差几分钟就会永远判「没变」；后来改成 mtime 自比，但 SMB 上
      // 每个目录一次 stat 要 30 多秒。指纹既没有时钟问题，也几乎零成本。
      const todo = dirs.filter((d) => {
        if (full) return true;
        const prev = this.dirs[d.rel];
        if (!prev) return true;
        if (d.dayHint === today || d.dayHint === yesterday) return true;
        // 老索引没存指纹，但每条片段都有文件名，直接算出来比对，
        // 这样升级不用把全库重扫一遍。名字没变就说明目录内容没变。
        const oldSig = prev.sig || sigFromNames((prev.segs || []).map((s) => s.name));
        return d.sig !== oldSig;
      });

      this.log(
        `[scan] ${full ? '全量' : '增量'}：共 ${dirs.length} 个目录，需扫 ${todo.length} 个`
      );

      let done = 0;
      const src = { name: 0, dir: 0, mtime: 0, dropped: 0 };
      const concurrency = Math.max(1, this.cfg.scanConcurrency || 4);
      let cursor = 0;

      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= todo.length) return;
          const info = todo[i];
          try {
            const prev = this.dirs[info.rel];
            const known = new Map();
            if (prev) for (const s of prev.segs) known.set(s.name, s);

            const { segs, sources } = await scanDir(this.cfg, info, known);
            for (const k of Object.keys(sources)) src[k] += sources[k];
            this.dirs[info.rel] = {
              rel: info.rel,
              scannedAt: Date.now(),
              sig: info.sig,
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
            this.log(`[scan] 跳过 ${info.rel || '(根目录)'}: ${e.message}`);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

      // 没被重扫的目录也把指纹记上，下一轮就能直接比，不用再从文件名反推
      for (const d of dirs) if (this.dirs[d.rel]) this.dirs[d.rel].sig = d.sig;

      // ── 清理已经没有录像的目录 ──────────────────────────────────────
      // 录像只保留最近 N 个月时，NAS 每天都会删掉一批旧目录。以前这段只在
      // full 时执行，而定时扫描永远是增量，于是 `dirs` 里不存在的旧目录
      // 根本不会进入 todo，索引里的片段永远不消失：日历还能点到三个月前，
      // 点进去却是 404。现在每次扫描都清。
      //
      // 但「这次没扫到」不等于「被删了」：readdir 可能因权限抖动或 SMB
      // 断连失败。所以逐个复核，只删真的不存在 / 真的一个 mp4 都没有的；
      // 读不动的一律留着等下一轮，别让一次网络抖动把索引清掉一半。
      const alive = new Set(dirs.map((d) => d.rel));
      const stale = Object.keys(this.dirs).filter((k) => !alive.has(k));
      let pruned = 0;
      let kept = 0;
      for (const key of stale) {
        const abs = path.join(this.cfg.watchDir, ...(key ? key.split('/') : []));
        let names;
        try {
          names = await fs.readdir(abs);
        } catch (e) {
          if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
            delete this.dirs[key];
            pruned++;
          } else {
            kept++;
          }
          continue;
        }
        if (!names.some((n) => MP4.test(n))) {
          delete this.dirs[key];   // 目录还在，但 mp4 被清理脚本删光了
          pruned++;
        } else {
          kept++;
        }
      }
      if (pruned) this.log(`[scan] 清理 ${pruned} 个已无录像的目录（过期删除）`);
      if (kept) this.log(`[scan] ${kept} 个目录暂时读不到 / 内容有变，保留索引等下一轮`);

      this.reindex();
      this.lastScanAt = Date.now();
      this.lastError = '';
      await this.save();

      const ms = Date.now() - started;
      this.log(
        `[scan] 完成：${done} 个目录 / ${this.countSegments()} 条片段 / ${(ms / 1000).toFixed(1)}s`
      );
      // 时间到底是从哪儿认出来的 —— 只在有「非文件名」或「跳过」时才啰嗦，
      // 全是文件名时打一行反而噪音
      if (src.dir || src.mtime || src.dropped) {
        const bits = [`文件名 ${src.name}`, `目录 ${src.dir}`, `mtime ${src.mtime}`];
        if (src.dropped) bits.push(`无法定时间 ${src.dropped}（已跳过）`);
        this.log(`[scan] 时间来源：${bits.join(' / ')}`);
      }
      return {
        scanned: done,
        total: dirs.length,
        segments: this.countSegments(),
        sources: src,
        ms,
      };
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
      dir: s.dir,
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
