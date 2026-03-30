const fs = require('node:fs');
const path = require('node:path');
const { resolveLatestPerfDir } = require('./_output-dir');

const root = path.resolve(__dirname, '..');
const perfRootDir = path.join(root, 'test-output', 'perf-metrics');
const srcDir = resolveLatestPerfDir(perfRootDir);
const dstDir = path.join(root, 'examples');

const mappings = [
  ['summary.html', 'summary.example.html'],
  ['summary.csv', 'summary.example.csv'],
  ['summary_stats.csv', 'summary_stats.example.csv'],
];

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function shouldCopy(src, dst) {
  const srcStat = statSafe(src);
  if (!srcStat || !srcStat.isFile()) return { copy: false, srcStat: null };

  const dstStat = statSafe(dst);
  if (!dstStat || !dstStat.isFile()) return { copy: true, srcStat };

  if (srcStat.size !== dstStat.size) return { copy: true, srcStat };
  if (srcStat.mtimeMs > dstStat.mtimeMs + 1) return { copy: true, srcStat };
  return { copy: false, srcStat };
}

let missing = 0;
let updated = 0;
let skipped = 0;
for (const [srcName, dstName] of mappings) {
  const src = path.join(srcDir, srcName);
  const dst = path.join(dstDir, dstName);

  if (!fs.existsSync(src)) {
    missing += 1;
    console.warn(`[sync-examples] missing: ${src}`);
    continue;
  }

  const decision = shouldCopy(src, dst);
  if (!decision.copy) {
    skipped += 1;
    console.log(`[sync-examples] skipped (unchanged): ${dstName}`);
    continue;
  }

  fs.copyFileSync(src, dst);
  if (decision.srcStat) {
    fs.utimesSync(dst, decision.srcStat.atime, decision.srcStat.mtime);
  }
  updated += 1;
  console.log(`[sync-examples] updated: ${dstName}`);
}

if (missing > 0) {
  console.warn('[sync-examples] 일부 파일이 없어 예시 동기화를 건너뛰었습니다. 먼저 테스트를 실행해 산출물을 생성해 주세요.');
  process.exitCode = 1;
}

console.log(`[sync-examples] done: updated=${updated}, skipped=${skipped}, missing=${missing}`);
console.log(`[sync-examples] source: ${srcDir}`);
