'use strict';

/**
 * 运行时设置：把「能在不重启的前提下改」的配置项抽出来。
 *
 * 设计原则：
 * 1. 环境变量仍然是一等公民 —— 它决定「默认值」。settings.json 只存用户显式改过的项。
 * 2. 白名单驱动。没写进 SCHEMA 的键改不了（port/host/tz 这类必须重启才生效的，直接不给改）。
 * 3. 改完立刻写回内存里的同一个 cfg 对象，store / scanner 都持有它的引用，
 *    下次扫描自然用新值，不需要重建对象。
 */

const fs = require('fs/promises');
const path = require('path');

const SCHEMA = {
  port: {
    label: '端口',
    hint: '改完要重启服务才生效。填错会起不来，得手改 data/settings.json',
    type: 'int',
    min: 1,
    max: 65535,
  },
  host: {
    label: '监听地址',
    hint: '0.0.0.0 = 所有网卡都能访问；127.0.0.1 = 只允许本机',
    type: 'text',
    pattern: /^[0-9A-Za-z.:_-]{1,64}$/,
    placeholder: '0.0.0.0',
  },
  watchDir: {
    label: '监控目录',
    hint: '录像根目录，下面应当是 设备ID/YYYYMMDDHH 或直接 YYYYMMDDHH',
    type: 'path',
  },
  device: {
    label: '设备 ID',
    hint: '只索引这一台摄像头，留空表示全部',
    type: 'text',
    pattern: /^[A-Za-z0-9_-]{0,64}$/,
    placeholder: '留空 = 全部设备',
  },
  scanInterval: {
    label: '扫描间隔',
    hint: '多久检查一次新录像，0 表示只在启动和手动时扫',
    type: 'int',
    min: 0,
    max: 1440,
    unit: '分钟',
  },
  scanConcurrency: {
    label: '目录并发',
    hint: '同时扫描几个小时目录。读本地盘可以开到 8~16，走网络挂载建议 4~8',
    type: 'int',
    min: 1,
    max: 32,
    unit: '个',
  },
  fileConcurrency: {
    label: '文件并发',
    hint: '单个目录里同时探测几个 mp4 头',
    type: 'int',
    min: 1,
    max: 64,
    unit: '个',
  },
  probeDuration: {
    label: '读取真实时长',
    hint: '关掉则一律按「片段时长」估算，扫描更快但时长不准',
    type: 'bool',
  },
  segmentDuration: {
    label: '片段时长',
    hint: '探测失败时的兜底值',
    type: 'int',
    min: 1,
    max: 600,
    unit: '秒',
  },
  scanOnBoot: {
    label: '启动时扫描',
    hint: '服务起来后立刻扫一遍',
    type: 'bool',
  },
  gapThreshold: {
    label: '事件合并阈值',
    hint: '两段间隔小于这个值就算同一次活动（前端可临时覆盖）',
    type: 'int',
    min: 0,
    max: 86400,
    unit: '秒',
  },
  thumbCacheMaxMB: {
    label: '缩略图缓存上限',
    hint: '超过后不再生成新缩略图',
    type: 'int',
    min: 0,
    max: 102400,
    unit: 'MB',
  },
  ffmpeg: {
    label: 'ffmpeg 路径',
    hint: '生成缩略图用。留空 = 关闭缩略图；填错只会让缩略图接口 404，不影响回放',
    type: 'text',
    placeholder: 'ffmpeg',
  },
};

/**
 * 只读项：能展示，但不给改。剩下的这两项不是偷懒，是真的搬不动。
 */
const READONLY = {
  tz: {
    label: '时区',
    why: '决定所有时间戳归到哪一天。改了要重建索引，所以在环境变量里定',
  },
  dataDir: {
    label: '数据目录',
    why: 'settings.json 本身就在这个目录里，没法自己决定自己放哪',
  },
};

const envDefaults = {};
const overrides = {};
let filePath = '';

// ---------- 校验 ----------

function coerce(key, raw) {
  const spec = SCHEMA[key];
  if (!spec) throw new Error(`不支持的配置项：${key}`);

  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    throw new Error(`${spec.label} 只能是真/假`);
  }

  if (spec.type === 'int') {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${spec.label} 必须是整数`);
    if (n < spec.min || n > spec.max) {
      throw new Error(`${spec.label} 需要在 ${spec.min} ~ ${spec.max} 之间`);
    }
    return n;
  }

  const s = String(raw == null ? '' : raw).trim();

  if (spec.type === 'text') {
    if (spec.pattern && !spec.pattern.test(s)) throw new Error(`${spec.label} 含有不允许的字符`);
    return s;
  }

  if (spec.type === 'path') {
    if (!s) throw new Error(`${spec.label} 不能为空`);
    // 要求写绝对路径：resolve() 出来的永远是绝对路径，拿它判断等于没判断，
    // 而默默把相对路径解析到服务进程的 cwd 上，只会让人找不到录像去哪了
    if (!path.isAbsolute(s)) throw new Error(`${spec.label} 要写绝对路径（以 / 开头）`);
    return path.normalize(s);
  }

  throw new Error(`${spec.label} 类型未知`);
}

/** 路径要能读，避免把索引指到打不开的地方 */
async function checkReadable(p) {
  try {
    const st = await fs.stat(p);
    if (!st.isDirectory()) throw new Error('不是目录');
    await fs.readdir(p);
  } catch (e) {
    throw new Error(`监控目录无法读取：${e.message}`);
  }
}

// ---------- 载入 / 应用 ----------

async function load(cfg) {
  for (const k of Object.keys(SCHEMA)) envDefaults[k] = cfg[k];
  filePath = path.join(cfg.dataDir, 'settings.json');

  let data = null;
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`[settings] ${filePath} 读取失败（${e.message}），按默认值启动`);
    return { loaded: 0 };
  }

  let n = 0;
  for (const [k, v] of Object.entries(data || {})) {
    if (!SCHEMA[k]) continue;
    try {
      cfg[k] = coerce(k, v);
      // 值和环境变量默认值一模一样就不算「改过」，免得界面挂着没意义的「已修改」
      if (cfg[k] === envDefaults[k]) delete overrides[k];
      else overrides[k] = cfg[k];
      n++;
    } catch (e) {
      console.log(`[settings] 忽略 ${k}：${e.message}`);
    }
  }
  if (n) console.log(`[settings] 已应用 ${n} 项本地设置（${filePath}）`);
  return { loaded: n };
}

async function persist() {
  const tmp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(overrides, null, 1), 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * 应用一批修改。
 * @returns {{applied:string[], changed:object}}
 */
async function apply(cfg, patch) {
  if (!patch || typeof patch !== 'object') throw new Error('请求体必须是对象');
  const applied = [];
  const next = {};

  for (const [k, raw] of Object.entries(patch)) {
    const spec = SCHEMA[k];
    if (!spec) throw new Error(`不支持的配置项：${k}`);
    const val = coerce(k, raw);
    if (spec.type === 'path') await checkReadable(val);
    next[k] = val;
  }

  for (const [k, val] of Object.entries(next)) {
    if (cfg[k] === val) continue;
    cfg[k] = val;
    // 改回默认值就当没改过，顺手把覆盖项删掉
    if (val === envDefaults[k]) delete overrides[k];
    else overrides[k] = val;
    applied.push(k);
  }

  if (applied.length) await persist();
  return { applied, changed: next };
}

/** 恢复某项为环境变量提供的默认值 */
async function reset(cfg, key) {
  if (!SCHEMA[key]) throw new Error(`不支持的配置项：${key}`);
  delete overrides[key];
  cfg[key] = envDefaults[key];
  await persist();
  return cfg[key];
}

/** 给前端用的描述 */
function describe(cfg) {
  const items = Object.keys(SCHEMA).map((k) => {
    const spec = SCHEMA[k];
    return {
      key: k,
      label: spec.label,
      hint: spec.hint || '',
      type: spec.type,
      min: spec.min,
      max: spec.max,
      unit: spec.unit || '',
      placeholder: spec.placeholder || '',
      value: cfg[k],
      default: envDefaults[k],
      overridden: Object.prototype.hasOwnProperty.call(overrides, k),
    };
  });

  const readonly = Object.entries(READONLY).map(([k, s]) => ({
    key: k,
    value: cfg[k],
    label: s.label,
    why: s.why,
  }));
  return { items, readonly };
}

module.exports = { load, apply, reset, describe, SCHEMA };
