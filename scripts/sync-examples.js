const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'test-output', 'perf-metrics');
const dstDir = path.join(root, 'examples');

const mappings = [
  ['summary.html', 'summary.example.html'],
  ['summary.csv', 'summary.example.csv'],
  ['summary_stats.csv', 'summary_stats.example.csv'],
];

let missing = 0;
for (const [srcName, dstName] of mappings) {
  const src = path.join(srcDir, srcName);
  const dst = path.join(dstDir, dstName);

  if (!fs.existsSync(src)) {
    missing += 1;
    console.warn(`[sync-examples] missing: ${src}`);
    continue;
  }

  fs.copyFileSync(src, dst);
  console.log(`[sync-examples] updated: ${dstName}`);
}

if (missing > 0) {
  console.warn('[sync-examples] 일부 파일이 없어 예시 동기화를 건너뛰었습니다. 먼저 테스트를 실행해 산출물을 생성해 주세요.');
  process.exitCode = 1;
}
