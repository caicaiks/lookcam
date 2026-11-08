'use strict';

/**
 * 回归测试：录像过期被删除后，增量扫描要把索引一起清掉。
 *
 * 背景：NAS 上只保留最近 N 个月录像时，旧目录每天被清理。
 * 早期版本只有 full 扫描才 prune，而定时扫描永远是增量，
 * 结果旧片段永久留在索引里（日历能点到，播放 404）。
 *
 * 用法：node test/prune.js
 * 只用系统临时目录和假文件，不碰真实录像，也不依赖 npm 包。
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { Store } = require('../app/lib/store');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' | ' + detail : ''}`);
};

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lookcam-prune-'));
  const rec = path.join(tmp, 'rec');
  const dataDir = path.join(tmp, 'data');
  for (const d of ['2026110200', '2026110201', '2026110202']) {
    await fs.mkdir(path.join(rec, 'dev', d), { recursive: true });
  }
  await fs.mkdir(dataDir, { recursive: true });

  const put = (dir, name) => fs.writeFile(path.join(rec, 'dev', dir, name), 'fake-mp4');
  await put('2026110200', '02M39S_1793548959.mp4');
  await put('2026110200', '04M12S_1793549052.mp4');
  await put('2026110201', '02M00S_1793552400.mp4');
  await put('2026110202', '02M00S_1793556000.mp4');

  const cfg = {
    watchDir: rec,
    dataDir,
    indexFile: path.join(dataDir, 'index.json'),
    scanDepth: 4,
    device: '',
    scanConcurrency: 2,
    fileConcurrency: 4,
    probeDuration: false,
    segmentDuration: 60,
    gapThreshold: 300,
  };

  const logs = [];
  const store = new Store(cfg, (m) => logs.push(m));
  const dirs = () => Object.keys(store.dirs).sort();
  const nSegs = () => store.countSegments();

  try {
    // 1. 建索引
    await store.scan({ full: true });
    check('初始扫描收录 4 段', nSegs() === 4, `${nSegs()} 段 / ${dirs().length} 目录`);
    check('三个日期目录都在索引里', dirs().length === 3, dirs().join(', '));

    // 2. 整目录被删（NAS 过期清理最常见的方式）
    await fs.rm(path.join(rec, 'dev', '2026110201'), { recursive: true, force: true });
    await store.scan({ full: false });
    check('整目录删除后增量扫描会清掉', !dirs().includes('dev/2026110201'), dirs().join(', '));
    check('片段数 4 → 3', nSegs() === 3, `${nSegs()} 段`);
    check('清理会写日志', logs.some((l) => l.includes('过期删除')),
      logs.filter((l) => l.includes('清理')).slice(-1)[0] || '无');

    // 3. 目录还在，只删掉里面一个文件：指纹变化要触发重扫
    await put('2026110200', '06M00S_1793549160.mp4');
    await store.scan({ full: false });
    const before = nSegs();
    await fs.rm(path.join(rec, 'dev', '2026110200', '06M00S_1793549160.mp4'));
    await store.scan({ full: false });
    check('目录内删文件也能感知', nSegs() === before - 1, `${before} → ${nSegs()} 段`);
    const names = store.dirs['dev/2026110200'].segs.map((s) => s.name);
    check('被删的文件名不再出现在索引', !names.includes('06M00S_1793549160.mp4'), names.join(', '));

    // 4. 权限抖动不能误删索引（这里用 chmod 000 模拟 readdir 失败）
    const unreadable = path.join(rec, 'dev', '2026110202');
    const beforeKeep = nSegs();
    let skipped = false;
    await fs.chmod(unreadable, 0o000);
    try {
      await store.scan({ full: false });
      check('目录暂时读不到时保留索引', nSegs() === beforeKeep, `${beforeKeep} → ${nSegs()} 段`);
      check('有「保留索引」提示', logs.some((l) => l.includes('保留索引')),
        logs.filter((l) => l.includes('保留')).slice(-1)[0] || '无');
    } catch {
      skipped = true; // 以 root 运行时 chmod 000 不生效，跳过这两项
      console.log('SKIP  当前用户可绕过 chmod 000，跳过权限抖动用例');
    } finally {
      await fs.chmod(unreadable, 0o755);
    }
    if (!skipped) {
      await store.scan({ full: false });
      check('权限恢复后索引仍完整', nSegs() === beforeKeep, `${nSegs()} 段`);
    }

    // 5. 落盘与重启载入都要一致
    const onDisk = JSON.parse(await fs.readFile(cfg.indexFile, 'utf8'));
    const diskSegs = Object.values(onDisk.dirs).reduce((n, d) => n + d.segs.length, 0);
    check('index.json 与内存一致', diskSegs === nSegs(), `磁盘 ${diskSegs} / 内存 ${nSegs()}`);
    const store2 = new Store(cfg, () => {});
    await store2.load();
    check('重启后载入的索引也是干净的', store2.countSegments() === nSegs(),
      `${store2.countSegments()} 段 / ${store2.byDay.size} 天`);

    // 6. 老索引升级：没有 sig 字段也能直接比，不需要全量重扫
    const old = JSON.parse(await fs.readFile(cfg.indexFile, 'utf8'));
    for (const d of Object.values(old.dirs)) delete d.sig;
    await fs.writeFile(cfg.indexFile, JSON.stringify(old));
    const store3 = new Store(cfg, () => {});
    await store3.load();
    const r = await store3.scan({ full: false });
    check('旧索引升级无需全量重扫', r.scanned < Object.keys(store3.dirs).length,
      `需扫 ${r.scanned} / ${r.total}`);
    check('升级后片段数不变', store3.countSegments() === nSegs(), `${store3.countSegments()} 段`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
