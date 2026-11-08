'use strict';

/**
 * 纯 JS 解 mp4 的 mvhd / tkhd，拿真实时长和分辨率。
 * 不依赖 ffmpeg，也不整文件读 —— 只读头尾各几十 KB。
 *
 * 小米摄像头这两批文件都是 ftyp + free + mdat + moov，
 * 也就是 moov 在文件尾部，所以尾部读取必须按 'moov' 标记对齐，
 * 不能假定buffer 起点就是 box 边界。
 */

const fs = require('fs/promises');

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const MOOV_TAG = Buffer.from('moov', 'latin1');

/** 从 start 起顺序走 box，找 type；遇到超出范围的 box 就停 */
function walk(buf, start, end, type) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const t = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return null;
      size = Number(buf.readBigUInt64BE(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < 8) return null;
    if (t === type) {
      if (p + size > end) return null; // 这个 box 被截断了，不算
      return { pos: p, size, hdr };
    }
    p += size;
  }
  return null;
}

/** 在没有对齐起点的 buffer 里靠 'moov' 标记反推 box 起点 */
function locateMoov(buf) {
  let from = buf.length;
  for (let guard = 0; guard < 32; guard++) {
    const idx = buf.lastIndexOf(MOOV_TAG, from);
    if (idx < 4) return null;
    const start = idx - 4;
    let size = buf.readUInt32BE(start);
    let hdr = 8;
    if (size === 1) {
      if (start + 16 > buf.length) { from = idx - 1; continue; }
      size = Number(buf.readBigUInt64BE(start + 8));
      hdr = 16;
    }
    if (size >= 8 && start + size <= buf.length) {
      return { pos: start, size, hdr };
    }
    from = idx - 1;
  }
  return null;
}

function readMoov(buf, moov) {
  const inner = moov.pos + moov.hdr;
  const innerEnd = moov.pos + moov.size;

  const mvhd = walk(buf, inner, innerEnd, 'mvhd');
  if (!mvhd) return null;
  const c = mvhd.pos + mvhd.hdr;
  const ver = buf[c];
  let timescale, duration;
  if (ver === 1) {
    timescale = buf.readUInt32BE(c + 20);
    duration = Number(buf.readBigUInt64BE(c + 24));
  } else {
    timescale = buf.readUInt32BE(c + 12);
    duration = buf.readUInt32BE(c + 16);
  }
  if (!timescale || !duration) return null;
  const seconds = duration / timescale;

  // 分辨率：moov 里通常有两个 trak（先音频后视频），取第一个宽高非零的
  let res = null;
  let q = inner;
  while (q + 8 <= innerEnd) {
    const sz = buf.readUInt32BE(q);
    const tp = buf.toString('latin1', q + 4, q + 8);
    if (sz < 8) break;
    if (tp === 'trak') {
      const tkhd = walk(buf, q + 8, Math.min(q + sz, innerEnd), 'tkhd');
      if (tkhd) {
        const e = tkhd.pos + tkhd.size;
        if (e <= buf.length) {
          const w = buf.readUInt32BE(e - 8) >>> 16;
          const h = buf.readUInt32BE(e - 4) >>> 16;
          if (w > 0 && h > 0) {
            res = { width: w, height: h };
            break;
          }
        }
      }
    }
    q += sz;
  }
  return { duration: Math.round(seconds * 10) / 10, ...(res || {}) };
}

function parse(buf, start, end) {
  const moov = walk(buf, start, end, 'moov') || locateMoov(buf);
  return moov ? readMoov(buf, moov) : null;
}

/**
 * @returns {Promise<{duration:number,width?:number,height?:number}|null>}
 */
async function probe(filePath) {
  let fh = null;
  try {
    fh = await fs.open(filePath, 'r');
    const stat = await fh.stat();
    if (stat.size < 1024) return null;

    const headLen = Math.min(HEAD_BYTES, stat.size);
    const head = Buffer.allocUnsafe(headLen);
    await fh.read(head, 0, headLen, 0);
    const r = parse(head, 0, headLen);
    if (r) return r;

    if (stat.size > headLen) {
      const tailLen = Math.min(TAIL_BYTES, stat.size - headLen);
      const tail = Buffer.allocUnsafe(tailLen);
      await fh.read(tail, 0, tailLen, stat.size - tailLen);
      return parse(tail, 0, tailLen);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { probe };
