'use strict';

/* =========================================================
   Lookcam · 监控回看  前端
   数据全部来自 /api，视频走 /api/video 的 Range 代理。
   ========================================================= */

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');

const fmt = (t) => {
  t = Math.max(0, Math.floor(t));
  return pad(Math.floor(t / 3600) % 24) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60);
};
const fmtHM = (t) => {
  t = Math.max(0, Math.floor(t));
  return pad(Math.floor(t / 3600)) + ':' + pad(Math.floor(t / 60) % 60);
};
const fmtDur = (t) => {
  t = Math.round(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  if (h) return h + 'h' + pad(m) + 'm';
  return m ? m + 'm' + pad(s) + 's' : s + 's';
};
const fmtSize = (b) => {
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  return Math.round(b / 1024) + ' KB';
};
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const dayDate = (d) => new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));

/* ---------------- 状态 ---------------- */

const S = {
  status: null,
  days: [],          // [{day,count,hours,bytes,sec}]
  dayMap: new Map(),
  day: '',
  data: null,        // /api/day 的结果
  tab: 'timeline',
  month: '',
  playhead: 0,
  playing: false,
  speed: 1,
  skipGap: true,
  gapTh: 300,
  curIdx: -1,
  hourView: true,
  busy: false,
  settings: null,    // /api/settings 的结果
};

const video = $('#video');
const screenEl = $('#screen');

// 单段进度条
const scrubEl = $('#scrub');
const skTrack = $('#skTrack');
const skFill = $('#skFill');
const skBuf = $('#skBuf');
const skKnob = $('#skKnob');
const skTip = $('#skTip');
const skCur = $('#skCur');
const skDur = $('#skDur');

/* ---------------- API ---------------- */

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.status + '';
    try {
      const j = await r.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function loadStatus() {
  S.status = await api('/api/status');
  if (S.status.gapThreshold) S.gapTh = S.status.gapThreshold;
  renderStatus();
  return S.status;
}

async function loadDays() {
  const r = await api('/api/days');
  S.days = r.days || [];
  S.dayMap = new Map(S.days.map((d) => [d.day, d]));
}

async function loadDay(day) {
  try {
    S.data = await api(`/api/day?date=${day}&gap=${S.gapTh}`);
  } catch (e) {
    S.data = null;
  }
  return S.data;
}

async function selectDay(day, opts = {}) {
  if (!day) return;
  S.day = day;
  S.month = day.slice(0, 4) + '-' + day.slice(4, 6);
  S.curIdx = -1;
  stopVideo();
  await loadDay(day);
  const list = segs();
  S.playhead = list.length ? list[0].start : 0;
  if (opts.play && list.length) playSegment(0);
  renderAll();
}

const segs = () => (S.data && S.data.segments) || [];
const events = () => (S.data && S.data.events) || [];

/* ---------------- 状态条 ---------------- */

function renderStatus() {
  const st = S.status;
  if (!st) return;
  const dot = $('#idxDot');
  const txt = $('#idxText');
  dot.className = 'ok';
  if (st.lastError) {
    dot.classList.add('bad');
    txt.textContent = '索引异常：' + st.lastError;
    return;
  }
  if (st.scanning) {
    dot.classList.add('warn');
    txt.textContent = `扫描中… 已收录 ${st.dirs} 个目录`;
    return;
  }
  if (!st.segments) {
    dot.classList.add('warn');
    txt.textContent = '索引为空，等待首次扫描';
    return;
  }
  txt.innerHTML = `索引就绪 · <b>${st.segments.toLocaleString()}</b> 段 · <b>${fmtSize(st.bytes)}</b>`;
}

/* ---------------- 侧栏日历 ---------------- */

function renderCal() {
  const [y, m] = S.month.split('-').map(Number);
  $('#calMonth').textContent = `${y} 年 ${m} 月`;
  const first = new Date(y, m - 1, 1);
  const startWd = (first.getDay() + 6) % 7;
  const dim = new Date(y, m, 0).getDate();
  const g = $('#calGrid');
  g.innerHTML = '';

  for (let i = 0; i < startWd; i++) {
    const d = document.createElement('div');
    d.className = 'cell empty';
    g.appendChild(d);
  }

  const todayKey = todayStr();
  for (let d = 1; d <= dim; d++) {
    const key = `${y}${pad(m)}${pad(d)}`;
    const info = S.dayMap.get(key);
    const el = document.createElement('div');
    el.className = 'cell' + (info ? ' has' : '') + (key === S.day ? ' sel' : '') + (key === todayKey ? ' today' : '');
    if (info) {
      const ratio = Math.min(1, info.hours / 24);
      const a = 0.03 + ratio * 0.16;
      el.style.background = `rgba(255,105,0,${a.toFixed(3)})`;
      el.title = `${m}/${d} · ${info.hours} 小时有录像 · ${info.count} 段`;
    }
    el.innerHTML = `<span>${d}</span>`;
    el.onclick = () => {
      if (!info) return toast('该日无录像');
      selectDay(key, { play: false });
    };
    g.appendChild(el);
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/* ---------------- 24 小时柱 ---------------- */

function renderDayBar() {
  const bar = $('#daybar');
  bar.querySelectorAll('.hcol').forEach((e) => e.remove());
  const list = segs();
  const perHour = new Array(24).fill(0);
  for (const s of list) {
    if (s.hour >= 0 && s.hour < 24) perHour[s.hour]++;
  }
  const max = Math.max(1, ...perHour);
  const curH = Math.floor(S.playhead / 3600);

  for (let h = 0; h < 24; h++) {
    const col = document.createElement('div');
    col.className = 'hcol' + (S.hourView && curH === h ? ' sel' : '');
    col.dataset.h = h;
    const pct = perHour[h] ? Math.max(7, (perHour[h] / max) * 100) : 0;
    col.innerHTML =
      '<div class="trackbg"></div>' +
      (perHour[h] ? `<div class="fill" style="height:${pct}%"></div>` : '') +
      `<div class="lb">${pad(h)}</div>`;
    col.onclick = () => focusHour(h);
    col.onmouseenter = (e) =>
      showTip(e, `${pad(h)}:00 – ${pad(h)}:59 · ${perHour[h] ? perHour[h] + ' 分钟录像' : '无录像'}`);
    col.onmouseleave = hideTip;
    bar.appendChild(col);
  }
}

/* ---------------- 分钟格 ---------------- */

function renderHourStrip() {
  const strip = $('#hourStrip');
  if (!S.hourView) {
    strip.classList.add('hide');
    return;
  }
  strip.classList.remove('hide');
  const h = Math.min(23, Math.floor(S.playhead / 3600));
  const hStart = h * 3600;
  const inHour = segs().filter((s) => s.start < hStart + 3600 && s.start + s.dur > hStart);

  const mins = new Set();
  for (const s of inHour) {
    const a = Math.max(0, Math.floor((s.start - hStart) / 60));
    const b = Math.min(59, Math.floor((s.start + s.dur - 1 - hStart) / 60));
    for (let i = a; i <= b; i++) mins.add(i);
  }

  $('#hsRange').textContent = `${pad(h)}:00 – ${pad(h)}:59`;
  $('#hsInfo').textContent = `· ${inHour.length} 个片段 · ${mins.size} 分钟有画面`;

  // 把「有录像的分钟」合并成连续区段，画成一整条轨道上的实心块，
  // 不再是一格一格的方块（相邻分钟会连成一体）。
  const runs = [];
  let from = -1;
  for (let m = 0; m <= 60; m++) {
    const on = m < 60 && mins.has(m);
    if (on && from < 0) from = m;
    if (!on && from >= 0) {
      runs.push([from, m - 1]);
      from = -1;
    }
  }
  $('#hsRuns').innerHTML = runs
    .map(([a, b]) => {
      const left = (a / 60) * 100;
      const width = ((b - a + 1) / 60) * 100;
      return `<i style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></i>`;
    })
    .join('');

  S.hourStart = hStart;
  S.hourMins = mins;

  $('#minScale').innerHTML = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
    .map((v) => `<span style="left:${((v / 60) * 100).toFixed(3)}%">${pad(v)}</span>`)
    .join('');
}

/* ---------------- 播放头 / 播放器信息 ---------------- */

let rafId = null;

function renderPlayhead() {
  const pctDay = Math.max(0, Math.min(100, (S.playhead / 86400) * 100));
  $('#phDay').style.left = pctDay + '%';

  const h = Math.min(23, Math.floor(S.playhead / 3600));
  const pctH = ((S.playhead % 3600) / 3600) * 100;
  $('#phHour').style.left = Math.max(0, Math.min(100, pctH)) + '%';

  $('#posTxt').textContent = fmt(S.playhead);
  $('#scrTime').textContent = fmt(S.playhead);
}

function renderPlayer() {
  const list = segs();
  const idx = list.findIndex((s) => S.playhead >= s.start && S.playhead < s.start + s.dur);
  const seg = idx >= 0 ? list[idx] : null;

  if (seg) {
    $('#pTime').textContent = fmt(seg.start);
    $('#pFile').textContent = seg.name;
    $('#pIdx').textContent = `${idx + 1} / ${list.length}`;
    $('#pDur').textContent = `${Math.round(seg.dur)} 秒`;
    $('#pSize').textContent = fmtSize(seg.size);
    const prev = list[idx - 1];
    $('#pGap').textContent = prev ? fmtDur(seg.start - (prev.start + prev.dur)) : '—';
    if (seg.width && seg.height) $('#scrRes').textContent = `${seg.width}×${seg.height}`;
    S.curIdx = idx;
  } else {
    $('#pTime').textContent = fmt(S.playhead);
    $('#pFile').textContent = list.length ? '无录像' : '该日没有录像';
    $('#pIdx').textContent = '—';
    $('#pSize').textContent = '—';
    S.curIdx = -1;
  }

  document.querySelectorAll('.hcol').forEach((c) => {
    c.classList.toggle('sel', +c.dataset.h === Math.floor(S.playhead / 3600));
  });
}

/* ---------------- 概况 / 事件 ---------------- */

function renderStats() {
  const st = S.data && S.data.stats;
  if (!st || !st.count) {
    $('#stRec').textContent = '—';
    $('#stSpan').textContent = '—';
    $('#stCov').textContent = '—';
    $('#stSize').textContent = '—';
    $('#evCount').textContent = '';
    $('#dayTag').textContent = '';
    $('#evMini').innerHTML = '<div style="font-size:11.5px;color:var(--dim2);padding:6px 2px">该日没有录像</div>';
    return;
  }

  $('#stRec').innerHTML = `${(st.sec / 3600).toFixed(1)}<small>h</small>`;
  $('#stSpan').innerHTML = `${(st.span / 3600).toFixed(1)}<small>h</small>`;
  $('#stCov').innerHTML = `${st.coverage}<small>%</small>`;
  $('#stSize').innerHTML = fmtSize(st.bytes);

  const d = S.day;
  $('#dayTag').textContent = `${+d.slice(4, 6)}/${+d.slice(6, 8)} 周${WD[dayDate(d).getDay()]}`;

  const evs = events();
  $('#evCount').textContent = `${evs.length} 段`;
  $('#evMini').innerHTML = evs
    .map(
      (e) => `
    <div class="ev" data-start="${e.start}">
      <div class="r1"><span class="t">${fmtHM(e.start)} – ${fmtHM(e.end)}</span><span class="d">${fmtDur(e.sec)}</span></div>
      <div class="r2"><span>${e.count} 段</span><div class="mini">${'<i style="flex:1"></i>'.repeat(Math.min(e.count, 40))}</div></div>
    </div>`
    )
    .join('');

  $('#evMini').querySelectorAll('.ev').forEach((el) => {
    el.onclick = () => seekTo(+el.dataset.start, true);
  });
}

function renderEvents() {
  const evs = events();
  const list = segs();
  const grid = $('#evGrid');
  if (!evs.length) {
    grid.innerHTML = '<div style="color:var(--dim2);padding:30px 4px">该日无事件段</div>';
    return;
  }

  grid.innerHTML = evs
    .map((e) => {
      const span = Math.max(300, e.end - e.start);
      const bars = list
        .filter((s) => s.start >= e.start - 1 && s.start + s.dur <= e.end + 1)
        .map(
          (s) =>
            `<i style="left:${(((s.start - e.start) / span) * 100).toFixed(2)}%;width:${Math.max(1.2, (s.dur / span) * 100).toFixed(2)}%"></i>`
        )
        .join('');
      return `<div class="evrow" data-start="${e.start}">
        <div class="ic"><svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg></div>
        <div class="mid">
          <div class="rt"><span class="a">${fmt(e.start)}</span><span class="sep">→</span><span class="a">${fmt(e.end)}</span></div>
          <div class="meta"><span>${e.count} 个片段</span><span>跨度 ${fmtHM(e.span)}</span><span>有效画面 ${fmtHM(e.sec)}</span></div>
        </div>
        <div class="vis">${bars}</div>
        <div class="dur">${fmtDur(e.sec)}</div>
      </div>`;
    })
    .join('');

  grid.querySelectorAll('.evrow').forEach((el) => {
    el.onclick = () => {
      switchTab('timeline');
      seekTo(+el.dataset.start, true);
    };
  });
}

/* ---------------- 月历 ---------------- */

function renderBigCal() {
  const [y, m] = S.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startWd = (first.getDay() + 6) % 7;
  const dim = new Date(y, m, 0).getDate();
  const todayKey = todayStr();

  let html = '';
  for (let i = 0; i < startWd; i++) html += '<div class="dcell off"></div>';

  for (let d = 1; d <= dim; d++) {
    const key = `${y}${pad(m)}${pad(d)}`;
    const info = S.dayMap.get(key);
    const isFuture = key > todayKey;
    const a = info ? 0.02 + Math.min(1, info.hours / 24) * 0.15 : 0;
    const style = info
      ? `background:rgba(255,105,0,${a.toFixed(3)})`
      : isFuture
      ? 'opacity:.28'
      : 'opacity:.55';
    html += `<div class="dcell ${key === S.day ? 'sel' : ''}" data-day="${key}" style="${style}"
        title="${m}/${d} · ${info ? info.hours + ' 小时有录像 · ' + info.count + ' 段' : '无记录'}">
      <div style="display:flex;justify-content:space-between">
        <span class="n">${d}</span><span class="hm">${info ? info.hours + 'h' : ''}</span>
      </div>
      <div></div>
      ${info ? `<div class="heat"><i style="width:${Math.min(100, (info.hours / 24) * 100)}%"></i></div>` : ''}
    </div>`;
  }

  $('#calBig').innerHTML = html;
  $('#calBig').querySelectorAll('.dcell[data-day]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.day;
      if (!S.dayMap.has(k)) return toast('该日无录像');
      selectDay(k);
      switchTab('timeline');
    };
  });
}

/* ---------------- 视频播放 ---------------- */

function videoUrl(seg) {
  const k = S.day + pad(seg.hour);
  const q = new URLSearchParams({ d: seg.device || '', k, f: seg.name });
  return '/api/video?' + q.toString();
}

/* 播放速率必须压在 defaultPlaybackRate 上：video.load() 会把 playbackRate
   重置回默认值，只在换源前设一次等于没设（表现为「界面写着 4x，实际 1x」）。 */
function applySpeed() {
  video.defaultPlaybackRate = S.speed;
  video.playbackRate = S.speed;
  const el = $('#scrRate');
  if (el) el.textContent = S.speed + 'x';
}

function playSegment(idx, autoplay = true) {
  const list = segs();
  if (idx < 0 || idx >= list.length) return;
  const seg = list[idx];
  S.curIdx = idx;
  S.playhead = seg.start;

  screenEl.classList.add('has-video');
  screenEl.classList.add('loading');

  video.src = videoUrl(seg);
  video.load();
  applySpeed();          // load() 之后重新压一次速率
  video.addEventListener('loadedmetadata', applySpeed, { once: true });

  if (autoplay) {
    const p = video.play();
    if (p && p.catch) {
      p.catch(() => {
        // 浏览器拦了「带声音自动播放」：静音再试一次。
        // 这里必须同时把 volState.m 也置 true —— 否则界面显示静音、内部却认为没静音，
        // 用户点一次喇叭是「再静音一次」，得点两下才出声。
        video.muted = true;
        volState.m = true;
        paintVol();
        video.play().catch(() => {});
      });
    }
  }

  renderPlayer();
  renderPlayhead();
  renderScrub();
  startRaf();
}

function stopVideo() {
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {}
  S.playing = false;
  screenEl.classList.remove('has-video');
  updatePlayIcon();
  stopRaf();
  renderScrub();
}

video.addEventListener('playing', () => {
  S.playing = true;
  screenEl.classList.remove('loading');
  updatePlayIcon();
  startRaf();
});

video.addEventListener('waiting', () => {
  screenEl.classList.add('loading');
});

video.addEventListener('canplay', () => {
  screenEl.classList.remove('loading');
});

video.addEventListener('pause', () => {
  S.playing = false;
  updatePlayIcon();
  stopRaf();
});

video.addEventListener('ended', () => {
  nextSegment(true);
});

video.addEventListener('loadedmetadata', () => {
  screenEl.classList.remove('loading');
});

/* ---------------- 单段进度条（可拖拽） ----------------
   两层时间轴管「定位到哪一段」，这条进度条管「在这一段 60 秒里拖到第几秒」。
   拖动时先暂停：每改一次 currentTime 都可能重新取一段字节，
   边拖边播会互相抢，所以视觉上实时跟手，实际 seek 限流到 150ms 一次。
   （走网络挂载时这个限流尤其重要，否则一次拖动就打出几十个 Range 请求） */

let skDrag = null;

function fmtSec(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderScrub() {
  const dur = video.duration;
  const ready = S.curIdx >= 0 && isFinite(dur) && dur > 0;
  scrubEl.classList.toggle('disabled', !ready);

  if (skDrag) return;            // 拖动中由指针事件接管，别被播放进度抢回去

  if (!ready) {
    skFill.style.width = '0%';
    skKnob.style.left = '0%';
    skBuf.style.width = '0%';
    skCur.textContent = '0:00';
    skDur.textContent = '0:00';
    return;
  }

  const t = Math.min(video.currentTime || 0, dur);
  const pct = (t / dur) * 100;
  skFill.style.width = pct + '%';
  skKnob.style.left = pct + '%';
  skCur.textContent = fmtSec(t);
  skDur.textContent = fmtSec(dur);

  let buf = 0;
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) {
        buf = video.buffered.end(i);
        break;
      }
    }
    if (!buf && video.buffered.length) buf = video.buffered.end(video.buffered.length - 1);
  } catch {}
  skBuf.style.width = Math.min(100, (buf / dur) * 100) + '%';
}

function scrubRatio(e) {
  const r = skTrack.getBoundingClientRect();
  if (!r.width) return 0;
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

function scrubPaint(ratio, t, dur) {
  skFill.style.width = ratio * 100 + '%';
  skKnob.style.left = ratio * 100 + '%';
  skCur.textContent = fmtSec(t);
  skDur.textContent = fmtSec(dur);
  skTip.style.left = ratio * 100 + '%';
  skTip.textContent = fmtSec(t);
}

function onScrubMove(e) {
  const ratio = scrubRatio(e);
  const t = ratio * skDrag.dur;
  skDrag.t = t;
  scrubPaint(ratio, t, skDrag.dur);

  const now = performance.now();
  if (now - skDrag.last > 150) {
    skDrag.last = now;
    try { video.currentTime = t; } catch {}
  }
}

skTrack.addEventListener('pointerdown', (e) => {
  const dur = video.duration;
  if (S.curIdx < 0 || !isFinite(dur) || dur <= 0) return;
  e.preventDefault();
  try { skTrack.setPointerCapture(e.pointerId); } catch {}
  clearGapTimer();          // 用户主动拖进度条，就别再自动跳空档了
  skDrag = { dur, t: video.currentTime || 0, wasPlaying: !video.paused, last: 0 };
  scrubEl.classList.add('dragging');
  video.pause();
  onScrubMove(e);
});

skTrack.addEventListener('pointermove', (e) => {
  const dur = video.duration;
  if (!skDrag) {
    // 没在拖：只做悬停时间提示，不动播放
    if (S.curIdx < 0 || !isFinite(dur) || dur <= 0) return;
    const ratio = scrubRatio(e);
    skTip.style.left = ratio * 100 + '%';
    skTip.textContent = fmtSec(ratio * dur);
    scrubEl.classList.add('hover');
    return;
  }
  onScrubMove(e);
});

function endScrub() {
  if (!skDrag) return;
  const { t, dur, wasPlaying } = skDrag;
  skDrag = null;
  scrubEl.classList.remove('dragging');
  try { video.currentTime = Math.min(t, dur - 0.05); } catch {}
  renderScrub();
  if (wasPlaying) video.play().catch(() => {});
}

skTrack.addEventListener('pointerup', endScrub);
skTrack.addEventListener('pointercancel', endScrub);
skTrack.addEventListener('pointerleave', () => {
  if (!skDrag) scrubEl.classList.remove('hover');
});

video.addEventListener('timeupdate', renderScrub);
video.addEventListener('seeked', renderScrub);
video.addEventListener('loadedmetadata', renderScrub);
video.addEventListener('durationchange', renderScrub);

/* ---------------- 播放器尺寸 ----------------
   视频源是 16:9，但可用高度由「扣掉控制条和时间轴之后剩多少」决定。
   窗口够高时让播放器正好 16:9，不够高就退化为整宽 + 等比缩放，
   否则内容会溢出把底部时间轴裁掉（实测能裁掉 35px）。 */
const SCRUB_H = 30;
const SCREEN_BORDER = 12;            // .screen 的 6px 白边框 × 2

function fitStage() {
  const col = document.querySelector('.screencol');
  if (!col) return;
  const availW = col.clientWidth;
  const availH = col.clientHeight - SCRUB_H;
  if (availW < 80 || availH < 80) return;   // 视图被隐藏时不算

  const ideal = ((availW - SCREEN_BORDER) * 9) / 16 + SCREEN_BORDER;
  col.style.setProperty('--sh', Math.round(Math.min(availH, ideal)) + 'px');
  renderScrub();
}

window.addEventListener('resize', () => requestAnimationFrame(fitStage));

function startRaf() {
  if (rafId) return;
  const tick = () => {
    if (!S.playing || S.curIdx < 0) {
      rafId = null;
      return;
    }
    const seg = segs()[S.curIdx];
    if (seg) {
      S.playhead = seg.start + (video.currentTime || 0);
      renderPlayhead();
      renderScrub();
      const h = Math.min(23, Math.floor(S.playhead / 3600));
      const sel = document.querySelector('.hcol.sel');
      if (!sel || +sel.dataset.h !== h) {
        document.querySelectorAll('.hcol').forEach((c) => c.classList.toggle('sel', +c.dataset.h === h));
        if (S.hourView) renderHourStrip();
      }
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopRaf() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function updatePlayIcon() {
  $('#icoPlay').innerHTML = S.playing
    ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
}

let gapTimer = null;

function nextSegment(auto) {
  clearGapTimer();
  const list = segs();
  if (!list.length) return;
  const i = S.curIdx;
  if (i < 0) return playSegment(firstIdxAtOrAfter(S.playhead));
  if (i + 1 >= list.length) {
    toast('已经是当天最后一段');
    video.pause();
    return;
  }

  const cur = list[i];
  const nxt = list[i + 1];
  const gap = nxt.start - (cur.start + cur.dur);

  if (auto && gap > 2 && !S.skipGap) {
    // 不跳空档：按倍速把这段空白「等」过去，但最多等 20 秒真实时间
    const waitMs = Math.min((gap * 1000) / S.speed, 20000);
    showGap(gap);
    animatePlayhead(cur.start + cur.dur, nxt.start, waitMs);
    gapTimer = setTimeout(() => {
      hideGap();
      playSegment(i + 1);
    }, waitMs);
    return;
  }

  if (auto && gap > 2) toast(`跳过空档 ${fmtDur(gap)}`);
  playSegment(i + 1);
}

function animatePlayhead(from, to, ms) {
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    S.playhead = from + (to - from) * k;
    renderPlayhead();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function showGap(gap) {
  $('#gapDur').textContent = fmtDur(gap);
  $('#gapMsg').classList.add('show');
}
function hideGap() {
  $('#gapMsg').classList.remove('show');
}
function clearGapTimer() {
  if (gapTimer) clearTimeout(gapTimer);
  gapTimer = null;
  hideGap();
}

function firstIdxAtOrAfter(t) {
  const list = segs();
  const i = list.findIndex((s) => t < s.start + s.dur);
  return i < 0 ? list.length - 1 : i;
}

function seekTo(t, autoplay = true) {
  const list = segs();
  if (!list.length) return;
  t = Math.max(0, Math.min(86399, t));
  let idx = list.findIndex((s) => t >= s.start && t < s.start + s.dur);
  if (idx < 0) idx = list.findIndex((s) => s.start >= t);
  if (idx < 0) idx = list.length - 1;
  playSegment(idx, autoplay);
  renderAll();
}

function focusHour(h) {
  const list = segs();
  const first = list.find((s) => s.hour === h);
  S.hourView = true;
  if (first) {
    seekTo(first.start, true);
  } else {
    S.playhead = h * 3600;
    renderAll();
    toast(`${pad(h)}:00 这一小时没有录像`);
  }
}

function jumpSeg(dir) {
  const list = segs();
  if (!list.length) return;
  let i = S.curIdx;
  if (i < 0) i = firstIdxAtOrAfter(S.playhead);
  i = Math.max(0, Math.min(list.length - 1, i + dir));
  playSegment(i);
}

function togglePlay() {
  if (!segs().length) return toast('该日没有录像');
  if (S.playing) {
    video.pause();
  } else {
    if (S.curIdx < 0) playSegment(firstIdxAtOrAfter(S.playhead));
    else video.play().catch(() => {});
  }
}

/* ---------------- 视图切换 ---------------- */

function switchTab(t) {
  S.tab = t;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $('#viewTimeline').style.display = t === 'timeline' ? 'flex' : 'none';
  $('#viewTimeline').classList.toggle('hide', t !== 'timeline');
  $('#viewEvents').classList.toggle('hide', t !== 'events');
  $('#viewCalendar').classList.toggle('hide', t !== 'calendar');
  $('#viewSettings').classList.toggle('hide', t !== 'settings');
  if (t === 'events') renderEvents();
  if (t === 'calendar') renderBigCal();
  if (t === 'settings') loadSettings().catch((e) => toast('读取配置失败：' + e.message));
  if (t === 'timeline') requestAnimationFrame(fitStage);   // 从隐藏切回来要重算尺寸
}

/* ---------------- 设置页 ----------------
   表单完全由 /api/settings 的 describe() 结果驱动：
   后端 SCHEMA 里加一项，前端自动多一行，不用两边各改一次。
   改动即时提交（change 事件 = 失焦/回车），失败就整块重绘回服务端的真实值，
   避免界面停在一个没存进去的假值上。 */

const SET_GROUPS = [
  { t: '监控与索引', d: '录像目录和扫描节奏', keys: ['watchDir', 'device', 'scanInterval', 'scanOnBoot'] },
  {
    t: '扫描性能',
    d: '并发不是越大越好：读本地盘可以高些，走网络挂载要低些',
    keys: ['scanConcurrency', 'fileConcurrency', 'probeDuration', 'segmentDuration'],
  },
  {
    t: '事件与缩略图',
    d: '影响前端怎样合并事件，以及缩略图怎么生成、缓存多少',
    keys: ['gapThreshold', 'thumbCacheMaxMB', 'ffmpeg'],
  },
  { t: '服务', d: '监听地址和端口，改完要重启服务', keys: ['port', 'host'] },
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setCtrlHTML(it) {
  if (it.type === 'bool') {
    return `<label class="sw" title="${it.value ? '已开启' : '已关闭'}">
      <input type="checkbox" data-k="${it.key}"${it.value ? ' checked' : ''}><i></i>
    </label>`;
  }
  if (it.type === 'int') {
    return `<div class="fld">
      <input type="number" data-k="${it.key}" value="${it.value}"
             min="${it.min}" max="${it.max}" step="1" inputmode="numeric">
      <span class="u">${esc(it.unit)}</span>
    </div>`;
  }
  return `<div class="fld${it.type === 'path' ? ' wide' : ''}">
    <input type="text" data-k="${it.key}" value="${esc(it.value)}"
           placeholder="${esc(it.placeholder)}" spellcheck="false" autocomplete="off">
  </div>`;
}

function setRowHTML(it) {
  const tag = it.overridden ? '<span class="tag">已修改</span>' : '';
  return `<div class="setrow${it.overridden ? ' dirty' : ''}" data-k="${it.key}">
    <div class="sl">
      <div class="sn">${esc(it.label)}${tag}</div>
      <div class="sh">${esc(it.hint)}</div>
    </div>
    <div class="sc">
      ${setCtrlHTML(it)}
      <button class="rst" data-rst="${it.key}" ${it.overridden ? '' : 'disabled'}
              title="恢复为环境变量默认值">重置</button>
    </div>
  </div>`;
}

function setCardHTML(title, desc, rows) {
  if (!rows) return '';
  return `<div class="setcard">
    <div class="ch"><h3>${esc(title)}</h3><span>${esc(desc || '')}</span></div>
    ${rows}
  </div>`;
}

function renderSettings() {
  const d = S.settings;
  const wrap = $('#setWrap');
  if (!d || !wrap) return;

  const byKey = new Map(d.items.map((i) => [i.key, i]));
  const used = new Set();
  const cards = [];

  for (const g of SET_GROUPS) {
    const rows = g.keys.map((k) => byKey.get(k)).filter(Boolean);
    rows.forEach((r) => used.add(r.key));
    if (rows.length) cards.push(setCardHTML(g.t, g.d, rows.map(setRowHTML).join('')));
  }
  const rest = d.items.filter((i) => !used.has(i.key));
  if (rest.length) cards.push(setCardHTML('其它', '', rest.map(setRowHTML).join('')));

  const ro = (d.readonly || [])
    .map(
      (r) => `<div class="setrow">
        <div class="sl"><div class="sn">${esc(r.label)}</div>
          <div class="sh">${esc(r.why || '由环境变量控制')}</div></div>
        <div class="sc"><span class="val">${esc(r.value)}</span></div>
      </div>`
    )
    .join('');
  cards.push(setCardHTML('只能在环境变量里定', '这两项没法写进 settings.json，原因见下', ro));

  cards.push(`<div class="setnote">
    <div>
      <b>优先级</b>：这里的改动存在 <code>settings.json</code>，会覆盖环境变量；
      点「重置」删掉该项的本地值，回到环境变量给的默认值。
      带 <span class="tag">已修改</span> 标记的就是被覆盖过的项。
    </div>
  </div>`);

  wrap.innerHTML = cards.join('');
}

async function loadSettings() {
  S.settings = await api('/api/settings');
  renderSettings();
  return S.settings;
}

function setLabel(key) {
  const it = S.settings && S.settings.items.find((i) => i.key === key);
  return it ? it.label : key;
}

/** 重扫会改索引，扫完把状态和日历都刷一遍 */
async function afterRescan() {
  await loadStatus().catch(() => {});
  await loadDays().catch(() => {});
  renderAll();
}

async function saveSetting(key, value) {
  if (S.busy) return;
  S.busy = true;
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    S.settings = r;
    renderSettings();

    if (!r.applied || !r.applied.length) {
      toast('没有变化');
      return;
    }
    toast(r.note || `${setLabel(key)} 已保存`);

    if (r.rescan) {
      await afterRescan();
    } else if (key === 'gapThreshold') {
      S.gapTh = r.changed.gapThreshold;
      await loadDay(S.day);
      renderAll();
    }
  } catch (e) {
    renderSettings();          // 回滚到服务端的值，别让人对着一个假的输入框
    toast('保存失败：' + e.message);
  } finally {
    S.busy = false;
  }
}

async function resetSetting(key) {
  if (S.busy) return;
  S.busy = true;
  try {
    const r = await api('/api/settings/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    S.settings = r;
    renderSettings();
    toast(`${setLabel(key)} 已恢复默认`);
    if (r.rescan) await afterRescan();
    else if (key === 'gapThreshold') {
      S.gapTh = r.value;
      await loadDay(S.day);
      renderAll();
    }
  } catch (e) {
    renderSettings();
    toast('重置失败：' + e.message);
  } finally {
    S.busy = false;
  }
}

function bindSettings() {
  const wrap = $('#setWrap');

  wrap.addEventListener('change', (e) => {
    const el = e.target;
    const key = el.dataset && el.dataset.k;
    if (!key) return;

    if (el.type === 'checkbox') return void saveSetting(key, el.checked);

    const raw = el.value.trim();
    if (raw === '') {
      renderSettings();
      return void toast('不能为空，已还原');
    }
    saveSetting(key, raw);
  });

  wrap.addEventListener('click', (e) => {
    const key = e.target.dataset && e.target.dataset.rst;
    if (key) resetSetting(key);
  });

  $('#setRefresh').onclick = () =>
    loadSettings()
      .then(() => toast('已重新读取'))
      .catch((e) => toast('读取失败：' + e.message));

  $('#setScan').onclick = async () => {
    const btn = $('#setScan');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      await api('/api/scan?full=1&async=1', { method: 'POST' });
      await waitScanDone();
      toast('扫描完成');
      await afterRescan();
    } catch (e) {
      toast('扫描失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即扫描';
    }
  };
}

/** 等后台扫描结束。全量扫上千个目录大概几分钟，所以轮询而不是干等一个请求 */
async function waitScanDone() {
  await new Promise((r) => setTimeout(r, 600));   // 先让 scanning 标志置起来
  for (let i = 0; i < 900; i++) {
    const st = await api('/api/status');
    if (!st.scanning) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/* ---------------- 总渲染 ---------------- */

function renderAll() {
  $('#scrDate').textContent = S.day
    ? `${S.day.slice(0, 4)}-${S.day.slice(4, 6)}-${S.day.slice(6, 8)}`
    : '—';
  renderCal();
  renderDayBar();
  renderHourStrip();
  renderPlayer();
  renderStats();
  renderPlayhead();
  if (S.tab === 'events') renderEvents();
  if (S.tab === 'calendar') renderBigCal();
}

/* ---------------- toast / tip ---------------- */

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function showTip(e, text) {
  const el = $('#tip');
  el.textContent = text;
  const r = e.target.getBoundingClientRect();
  el.style.left = Math.max(6, r.left + r.width / 2 - el.offsetWidth / 2) + 'px';
  el.style.top = r.top - 30 + 'px';
  el.classList.add('show');
}
function hideTip() {
  $('#tip').classList.remove('show');
}

/* ---------------- 运行状态抽屉 ---------------- */

function renderDrawer() {
  const st = S.status || {};
  const days = S.days.length;
  const range = days ? `${S.days[0].day} → ${S.days[days.length - 1].day}` : '—';
  const last = st.lastScanAt ? new Date(st.lastScanAt).toLocaleString('zh-CN') : '还没扫过';

  $('#drawerBody').innerHTML = `
    <h4>索引</h4>
    <div class="kv">
      <div><span>片段总数</span><span>${(st.segments || 0).toLocaleString()}</span></div>
      <div><span>覆盖天数</span><span>${days}</span></div>
      <div><span>日期范围</span><span>${range}</span></div>
      <div><span>占用容量</span><span>${fmtSize(st.bytes || 0)}</span></div>
      <div><span>已扫目录</span><span>${st.dirs || 0}</span></div>
      <div><span>上次扫描</span><span>${last}</span></div>
      <div><span>扫描中</span><span>${st.scanning ? '是' : '否'}</span></div>
    </div>
    <button class="ghost scan-btn" id="btnRescan">重新扫描全部目录</button>
    <p style="margin-top:8px;font-size:11px;color:var(--dim2)">全量扫描不会删除索引，只补新增目录。磁盘上已消失的录像会在全量扫描时一并清掉。</p>

    <h4>运行环境</h4>
    <div class="kv">
      <div><span>监控目录</span><span style="font-size:10.5px">${st.watchDir || '—'}</span></div>
      <div><span>数据目录</span><span style="font-size:10.5px">${st.dataDir || '—'}</span></div>
      <div><span>时区</span><span>${st.tz || '—'}</span></div>
      <div><span>端口</span><span>${st.port || '—'}</span></div>
      <div><span>已运行</span><span>${Math.floor((st.uptime || 0) / 60)} 分钟</span></div>
    </div>
    <p style="font-size:11px;color:var(--dim2)">端口、监控目录、数据目录全部由环境变量控制（PORT / WATCH_DIR / DATA_DIR），改完重启容器即可，不用改代码。</p>

    <h4>缩略图</h4>
    <p>时间轴悬停预览用的缩略图由容器内的 ffmpeg 实时抽帧，缓存写在数据目录，绝不回写监控目录。</p>
  `;

  const btn = $('#btnRescan');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '扫描中…';
      try {
        await api('/api/scan?full=1', { method: 'POST' });
        await loadStatus();
        await loadDays();
        toast('扫描完成');
        renderAll();
        renderDrawer();
      } catch (e) {
        toast('扫描失败：' + e.message);
        btn.disabled = false;
        btn.textContent = '重新扫描全部目录';
      }
    };
  }
}

/* ---------------- 绑定 ---------------- */

document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
bindSettings();

$('#btnPlay').onclick = togglePlay;
$('#btnPrev').onclick = () => jumpSeg(-1);
$('#btnNext').onclick = () => jumpSeg(1);

$('#spd').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.speed = +b.dataset.s;
  applySpeed();
  $('#spd').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
};

$('#btnSkip').onclick = () => {
  S.skipGap = !S.skipGap;
  $('#btnSkip').classList.toggle('on', S.skipGap);
  clearGapTimer();
  toast(S.skipGap ? '已开启：自动跳过无录像时段' : '已关闭：空档会停留一会儿');
};

/* ---------------- 音量 ----------------
   这批录像的音轨是 G.711 A-law（IP 摄像头常用的电话语音编码），
   Chrome / Safari 都能解，所以音量条是真能用的，不是摆设。
   音量与静音状态存 localStorage，换片段、刷新都不丢。 */
const VOL_KEY = 'lookcam.volume';
const MUTE_KEY = 'lookcam.muted';

const volState = (() => {
  let v = 1;
  let m = false;
  try {
    const s = localStorage.getItem(VOL_KEY);
    if (s != null && !Number.isNaN(+s)) v = Math.max(0, Math.min(1, +s));
    m = localStorage.getItem(MUTE_KEY) === '1';
  } catch {}
  return { v, m };
})();

function paintVol() {
  const pct = Math.round((video.volume || 0) * 100);
  const muted = video.muted || pct === 0;
  const range = $('#volRange');
  range.value = String(pct);
  range.style.background =
    `linear-gradient(90deg, var(--sig) 0% ${pct}%, #DFE3E8 ${pct}% 100%)`;
  const ico = $('#icoVol');
  ico.classList.remove('lv0', 'lv1', 'lv2');
  ico.classList.add(muted ? 'lv0' : pct < 50 ? 'lv1' : 'lv2');
  $('#volBtn').classList.toggle('muted', muted);
  $('#volBtn').title = muted ? '取消静音 (M)' : '静音 (M)';
}

function setVol(v, muted) {
  volState.v = Math.max(0, Math.min(1, v));
  volState.m = !!muted;
  try {
    localStorage.setItem(VOL_KEY, String(volState.v));
    localStorage.setItem(MUTE_KEY, volState.m ? '1' : '0');
  } catch {}
  video.volume = volState.v;
  video.muted = volState.m || volState.v === 0;
  paintVol();
}

$('#volRange').addEventListener('input', (e) => {
  const v = +e.target.value / 100;
  setVol(v, v === 0);       // 拖到最左自动静音
});

$('#volBtn').onclick = () => {
  if (volState.m || volState.v === 0) {
    setVol(volState.v === 0 ? 0.6 : volState.v, false);   // 从 0 静音里恢复给个默认音量
  } else {
    setVol(volState.v, true);
  }
};

setVol(volState.v, volState.m);

$('#hsClose').onclick = () => {
  S.hourView = false;
  $('#hourStrip').classList.add('hide');
};

/* 小时轨道：点一下定位、按住拖也能扫，悬停出时间气泡。
   拖动时按 300ms 节流 —— 每次定位都要重新 load 这一段视频，
   松手之前别把整条链路打满。 */
let hsDown = false;
let hsLastSeek = 0;

function hsPointAt(e) {
  const r = $('#hsTrack').getBoundingClientRect();
  const ratio = r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  return { ratio, t: (S.hourStart || 0) + ratio * 3600 };
}

function hsHover(e) {
  if (S.hourStart == null) return;
  const { ratio, t } = hsPointAt(e);
  const m = Math.max(0, Math.min(59, Math.floor((t - S.hourStart) / 60)));
  const tip = $('#hsTip');
  tip.style.left = ratio * 100 + '%';
  tip.textContent = `${fmt(t).slice(0, 5)} · ${S.hourMins && S.hourMins.has(m) ? '有录像' : '无录像'}`;
  $('#hsTrack').classList.add('show-tip');
}

/* 空档里点一下：seekTo 会顺延到最近的片段，但得说清楚，
   否则「点了 09:30 却从 09:49 开始播」会让人以为是 bug。 */
function hsSeek(e) {
  const { t } = hsPointAt(e);
  const m = Math.max(0, Math.min(59, Math.floor((t - (S.hourStart || 0)) / 60)));
  const has = S.hourMins && S.hourMins.has(m);
  seekTo(Math.round(t), true);
  if (!has) toast(`${fmt(t).slice(0, 5)} 没有录像，已跳到最近的片段`);
}

$('#hsTrack').addEventListener('pointerdown', (e) => {
  if (!S.hourView || S.hourStart == null) return;
  e.preventDefault();
  hsDown = true;
  hsLastSeek = performance.now();
  try { $('#hsTrack').setPointerCapture(e.pointerId); } catch {}
  hsHover(e);
  hsSeek(e);
});

$('#hsTrack').addEventListener('pointermove', (e) => {
  if (S.hourStart == null) return;
  hsHover(e);
  if (!hsDown) return;
  const now = performance.now();
  if (now - hsLastSeek < 300) return;
  hsLastSeek = now;
  hsSeek(e);
});

const hsEnd = () => { hsDown = false; };
$('#hsTrack').addEventListener('pointerup', hsEnd);
$('#hsTrack').addEventListener('pointercancel', hsEnd);
$('#hsTrack').addEventListener('pointerleave', () => {
  if (!hsDown) $('#hsTrack').classList.remove('show-tip');
});

$('#calPrev').onclick = () => shiftMonth(-1);
$('#calNext').onclick = () => shiftMonth(1);

function shiftMonth(d) {
  let [y, m] = S.month.split('-').map(Number);
  m += d;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  S.month = `${y}-${pad(m)}`;
  renderCal();
  if (S.tab === 'calendar') renderBigCal();
}

$('#gapTh').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.gapTh = +b.dataset.g;
  $('#gapTh').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  await loadDay(S.day);
  renderAll();
  renderEvents();
};

document.addEventListener('keydown', (e) => {
  const el = e.target;
  const isInput = el.tagName === 'INPUT';
  const isRange = isInput && el.type === 'range';
  if (isInput && !isRange) return;          // 文本框里打字不拦
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.code === 'KeyM') { e.preventDefault(); $('#volBtn').click(); return; }
  if (isRange) return;                       // 音量条聚焦时方向键交给它自己调音量
  if (e.code === 'ArrowLeft') { e.preventDefault(); jumpSeg(-1); }
  if (e.code === 'ArrowRight') { e.preventDefault(); jumpSeg(1); }
});

$('#btnDocs').onclick = () => {
  renderDrawer();
  $('#drawer').classList.add('open');
};
$('#drawerClose').onclick = () => $('#drawer').classList.remove('open');

// 点击画面空白处暂停/播放
$('#screen').addEventListener('click', (e) => {
  if (e.target.closest('.gapmsg')) return;
  togglePlay();
});

/* ---------------- 启动 ---------------- */

async function boot() {
  try {
    await loadStatus();
    await loadDays();

    // 默认打开最近有数据的那天
    const latest = S.days[S.days.length - 1];
    if (latest) {
      const autoPlay = new URLSearchParams(location.search).get('play') === '1';
      await selectDay(latest.day, { play: autoPlay });
    } else {
      toast('索引为空，等待首次扫描完成');
      renderAll();
    }

    switchTab(['events', 'calendar', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'timeline');
    requestAnimationFrame(fitStage);
  } catch (e) {
    toast('连接服务失败：' + e.message);
  }

  // 扫描中时刷新状态条
  setInterval(async () => {
    if (S.status && S.status.scanning) {
      try {
        await loadStatus();
        if (!S.status.scanning) {
          await loadDays();
          renderAll();
        }
      } catch {}
    }
  }, 3000);
}

/* ---------------- 编码能力检测 ----------------
   这台摄像头产出的都是 H.265(HEVC/hvc1) 封装在 MP4 里（Main profile, L5.0）。
   Safari 和 macOS 上的 Chrome 走系统硬解，能播；Firefox 不支持，
   Windows 的 Chrome 还要额外装 HEVC 扩展。不支持时画面必然全黑，
   与其让人对着黑屏猜，不如开屏就说清楚。 */
(function checkCodecSupport() {
  const v = document.createElement('video');
  const ok = [
    'video/mp4; codecs="hvc1.1.6.L150.90"',
    'video/mp4; codecs="hev1.1.6.L150.90"',
    'video/mp4; codecs="hvc1"',
  ].some((t) => v.canPlayType(t));
  if (!ok) {
    const bar = document.getElementById('codecWarn');
    if (bar) bar.hidden = false;
  }
})();

boot().then(() => {
  const qs = new URLSearchParams(location.search);
  if (qs.get('selftest') === '1') runSelfTest();
  if (qs.get('videotest') === '1') runVideoTest();
});

/* ---------------- 自测（页面加 ?selftest=1 触发） ----------------
   把核心链路跑一遍，结果写进 <pre id="selftest-out">，
   这样用无头浏览器 dump-dom 就能读到，不依赖人工点。 */
async function runSelfTest() {
  const out = [];
  const check = (name, pass, detail) =>
    out.push({ name, pass: !!pass, ...(detail !== undefined && detail !== '' ? { detail: String(detail) } : {}) });

  try {
    const st = await api('/api/status');
    check('索引已建立', st.segments > 0, `${st.segments} 段 / ${st.days} 天`);
    check('容量已统计', st.bytes > 0, fmtSize(st.bytes));

    const days = (await api('/api/days')).days;
    check('日历数据可读', days.length > 0, `${days.length} 天`);

    const target = days[days.length - 1].day;
    const day = await api(`/api/day?date=${target}`);
    check('单日数据可读', day.segments.length > 0, `${target}: ${day.segments.length} 段`);
    check(
      '片段时长正确',
      day.segments.every((s) => s.dur > 30 && s.dur < 120),
      `示例 ${day.segments[0].dur}s`
    );
    const withRes = day.segments.find((s) => s.width > 0);
    check('分辨率已解析', !!withRes, withRes ? `${withRes.width}×${withRes.height}` : '无');

    const dense = await api(`/api/day?date=${target}&gap=60`);
    const loose = await api(`/api/day?date=${target}&gap=600`);
    check(
      '合并阈值生效',
      dense.events.length > loose.events.length,
      `60s=${dense.events.length} / 600s=${loose.events.length}`
    );

    check('时间轴 24 根小时柱', document.querySelectorAll('#daybar .hcol').length === 24);
    const runs = document.querySelectorAll('#hsRuns i');
    check('小时轨道有录像区段', runs.length > 0, `${runs.length} 段连续区段`);
    check('侧栏日历已渲染', document.querySelectorAll('#calGrid .cell:not(.empty)').length > 0);
    check('统计卡片有值', $('#stRec').textContent !== '—', $('#stRec').textContent.trim());

    // 交互：点第 8 小时的柱子
    const col = document.querySelector('#daybar .hcol[data-h="8"]');
    if (col) {
      col.click();
      check('点击小时可定位', S.playhead >= 8 * 3600 && S.playhead < 9 * 3600, `播放头 ${fmt(S.playhead)}`);
    } else {
      check('点击小时可定位', false, '找不到 08 点柱子');
    }

    // 交互：点轨道上第一段有录像的位置
    const run = document.querySelector('#hsRuns i');
    if (run) {
      const tr = $('#hsTrack');
      const r = tr.getBoundingClientRect();
      const ratio = (parseFloat(run.style.left) + parseFloat(run.style.width) / 2) / 100;
      tr.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 9, bubbles: true, cancelable: true, isPrimary: true,
        clientX: r.left + r.width * ratio,
        clientY: r.top + r.height / 2,
      }));
      check('点击轨道可定位', S.curIdx >= 0, `命中第 ${S.curIdx + 1} 段`);
    } else {
      check('点击轨道可定位', false, '当前小时没有录像区段');
    }

    // 视频地址与 Range 支持
    const seg = segs()[0];
    if (seg) {
      const url = videoUrl(seg);
      check('视频地址构造正确', url.startsWith('/api/video?') && url.includes('k='), url);
      const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      check('Range 请求返回 206', r.status === 206, `HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      check('返回分片长度正确', buf.byteLength === 1024, `${buf.byteLength} 字节`);
    }

    // 音量控件
    const vr = $('#volRange');
    check(
      '音量滑块与 video 同步',
      !!vr && vr.value === String(Math.round((video.volume || 0) * 100)),
      `滑块 ${vr && vr.value} / 实际 ${video.volume}`
    );
    const beforeMute = video.muted;
    $('#volBtn').click();
    const afterMute = video.muted;
    $('#volBtn').click();          // 点回来，别把状态留给后面的测试
    check('静音按钮可切换', afterMute !== beforeMute && video.muted === beforeMute, `${beforeMute} → ${afterMute}`);

    // 视图切换
    switchTab('events');
    check('事件视图有内容', document.querySelectorAll('#evGrid .evrow').length > 0, `${document.querySelectorAll('#evGrid .evrow').length} 行`);
    switchTab('calendar');
    check('月历视图有内容', document.querySelectorAll('#calBig .dcell[data-day]').length > 0);

    // ---- 设置页 ----
    switchTab('settings');
    const cfg = await loadSettings();
    const rowCount = document.querySelectorAll('#setWrap .setrow').length;
    check(
      '设置项已加载',
      cfg.items.length >= 10 && (cfg.readonly || []).length > 0,
      `${cfg.items.length} 可改 / ${cfg.readonly.length} 只读`
    );
    check('设置表单已渲染', rowCount === cfg.items.length + cfg.readonly.length, `${rowCount} 行`);
    const dirInput = document.querySelector('#setWrap input[data-k="watchDir"]');
    const watchItem = cfg.items.find((i) => i.key === 'watchDir');
    check(
      '监控目录已填入当前值',
      !!dirInput && !!watchItem && dirInput.value === watchItem.value,
      dirInput ? dirInput.value : '无'
    );

    // 越界值要被后端拒绝
    let rejected = '';
    try {
      await api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanInterval: 99999 }),
      });
    } catch (e) {
      rejected = e.message;
    }
    check('越界配置被拒绝', !!rejected, rejected);

    // 真写一次再改回来，确认能落盘也能生效
    const ivBefore = cfg.items.find((i) => i.key === 'scanInterval').value;
    const ivTemp = ivBefore === 9 ? 8 : 9;
    await saveSetting('scanInterval', ivTemp);
    const ivNow = (await api('/api/settings')).items.find((i) => i.key === 'scanInterval').value;
    check('设置可写入并生效', ivNow === ivTemp, `${ivBefore} → ${ivNow}`);
    await saveSetting('scanInterval', ivBefore);
    const ivBack = (await api('/api/settings')).items.find((i) => i.key === 'scanInterval');
    check('改回原值即视为未修改', ivBack.value === ivBefore && !ivBack.overridden, `回到 ${ivBack.value}`);

    // 再走一遍真实的 DOM 路径：改输入框 → change → 保存 → 出现「已修改」；点重置 → 恢复默认
    const ivInput = document.querySelector('#setWrap input[data-k="scanInterval"]');
    const ivDom = Number(ivInput.value);
    ivInput.value = String(ivDom === 9 ? 8 : 9);
    ivInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const dirtyRow = document.querySelector('#setWrap .setrow[data-k="scanInterval"]');
    check(
      '改输入框即保存并标记',
      !!dirtyRow && dirtyRow.classList.contains('dirty') && !!dirtyRow.querySelector('.tag'),
      dirtyRow ? `值 ${dirtyRow.querySelector('input').value}` : '无'
    );

    if (dirtyRow) dirtyRow.querySelector('.rst').click();
    await new Promise((r) => setTimeout(r, 700));
    const cleanRow = document.querySelector('#setWrap .setrow[data-k="scanInterval"]');
    check(
      '重置按钮恢复默认值',
      !!cleanRow && !cleanRow.classList.contains('dirty'),
      cleanRow ? `回到 ${cleanRow.querySelector('input').value}` : '无'
    );

    switchTab('timeline');
  } catch (e) {
    check('测试执行', false, e.message);
  }

  const passed = out.filter((r) => r.pass).length;
  const pre = document.createElement('pre');
  pre.id = 'selftest-out';
  pre.style.cssText = 'position:fixed;left:-9999px;top:0';
  pre.textContent = JSON.stringify({ passed, total: out.length, results: out }, null, 1);
  document.body.appendChild(pre);
  document.title = `selftest ${passed}/${out.length}`;
}

// ?debug=1 时把 video 的内部状态打到标题上，方便排查「为什么是黑的」
if (new URLSearchParams(location.search).get('debug') === '1') {
  setInterval(() => {
    const t = (s, d = 0) => (s == null ? d : s);
    document.title =
      `rs=${t(video.readyState)} ct=${(video.currentTime || 0).toFixed(1)} ` +
      `dur=${(video.duration || 0).toFixed(1)} err=${video.error ? video.error.code : '-'} ` +
      `net=${video.networkState} paused=${video.paused} w=${video.videoWidth}x${video.videoHeight}`;
  }, 400);
}

/* ---------------- 视频链路自测（页面加 ?videotest=1 触发） ----------------
   自测只验证到「HTTP 能取到字节」，验证不到「解码出来的画面有没有内容」。
   这里真的把一帧画到 canvas 上算亮度，用来区分两种情况：
     - 平均亮度 ≈ 0  → 解码/渲染坏了
     - 平均亮度 > 0  → 解码正常，黑只是那个时间点画面本来就暗
   顺带验一下 ffmpeg 缩略图接口能不能出图。 */
async function runVideoTest() {
  const out = [];
  const log = (k, v) => out.push({ k, v: String(v) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const list = segs();
    if (!list.length) throw new Error('当天没有片段');
    // 挑最接近正午的那一段，避免清晨/夜里的画面本来就暗，导致误判
    const seg = list.reduce((a, b) =>
      Math.abs(b.start - 43200) < Math.abs(a.start - 43200) ? b : a);
    const hhmm = (t) =>
      `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
    log('测试片段', `${seg.name}（${hhmm(seg.start)}）`);
    log('片段时长', (seg.dur || 0).toFixed(1) + 's');
    log('索引里的分辨率', `${seg.width}x${seg.height}`);

    const v = video;
    v.muted = true;
    v.playbackRate = 1;
    v.src = videoUrl(seg);
    v.load();

    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('metadata 等待超时')), 8000);
      v.addEventListener('loadedmetadata', () => { clearTimeout(to); res(); }, { once: true });
      v.addEventListener('error', () => {
        clearTimeout(to);
        rej(new Error('video error code=' + (v.error && v.error.code)));
      }, { once: true });
    });

    log('解码时长', (v.duration || 0).toFixed(2) + 's');
    log('解码分辨率', `${v.videoWidth}x${v.videoHeight}`);

    // 跳到中段取一帧，避免刚好落在关键帧前的黑屏
    const target = Math.min(3, (v.duration || 4) / 2);
    await new Promise((res) => {
      const to = setTimeout(res, 6000);
      v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
      v.currentTime = target;
    });
    await sleep(500);
    log('定位到', (v.currentTime || 0).toFixed(2) + 's');
    log('readyState', v.readyState);

    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 320, 180);
    const px = ctx.getImageData(0, 0, 320, 180).data;
    let sum = 0;
    let max = 0;
    let lit = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
      sum += l;
      if (l > max) max = l;
      if (l > 12) lit++;
    }
    const avg = sum / n;
    log('平均亮度', avg.toFixed(2));
    log('最高亮度', max.toFixed(0));
    log('有内容像素', ((lit / n) * 100).toFixed(1) + '%');
    log('判定', avg > 2 && lit / n > 0.02 ? '画面正常（有内容）' : '画面接近全黑');

    // 缩略图（ffmpeg 抽帧）链路
    const tq = new URLSearchParams({ d: seg.device || '', k: S.day + pad(seg.hour), f: seg.name });
    const img = new Image();
    const thumbOk = await new Promise((res) => {
      img.onload = () => res(img.naturalWidth > 0);
      img.onerror = () => res(false);
      img.src = '/api/thumb?' + tq.toString();
      setTimeout(() => res(false), 8000);
    });
    log('缩略图接口', thumbOk ? `正常 ${img.naturalWidth}x${img.naturalHeight}` : '失败');
  } catch (e) {
    log('异常', e.message);
  }

  const pre = document.createElement('pre');
  pre.id = 'videotest-out';
  pre.style.cssText = 'position:fixed;left:-9999px;top:0';
  pre.textContent = JSON.stringify(out, null, 1);
  document.body.appendChild(pre);
  document.title = 'videotest done';
}
