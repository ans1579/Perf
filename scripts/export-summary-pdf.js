const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

function resolvePath(p, fallback) {
  const raw = (p || '').trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

async function main() {
  const defaultHtml = path.resolve(process.cwd(), 'test-output', 'perf-metrics', 'summary.html');
  const defaultPdf = path.resolve(process.cwd(), 'test-output', 'perf-metrics', 'summary.pdf');

  const inputHtml = resolvePath(process.argv[2], defaultHtml);
  const outputPdf = resolvePath(process.argv[3], defaultPdf);

  if (!fs.existsSync(inputHtml)) {
    throw new Error(`summary.html 파일을 찾지 못했습니다: ${inputHtml}`);
  }

  fs.mkdirSync(path.dirname(outputPdf), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
  await page.goto(`file://${inputHtml}`, { waitUntil: 'load' });
  await page.pdf({
    path: outputPdf,
    format: 'A4',
    printBackground: true,
    margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' },
  });
  await browser.close();

  console.log(`PDF 생성 완료: ${outputPdf}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
