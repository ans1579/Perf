const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

function resolvePath(p, fallback, cwd = process.cwd()) {
  const raw = (p || '').trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

async function generateSummaryPdf(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const defaultHtml = path.resolve(cwd, 'test-output', 'perf-metrics', 'summary.html');
  const defaultPdf = path.resolve(cwd, 'test-output', 'perf-metrics', 'summary.pdf');

  const inputHtml = resolvePath(options.inputHtml, defaultHtml, cwd);
  const outputPdf = resolvePath(options.outputPdf, defaultPdf, cwd);

  if (!fs.existsSync(inputHtml)) {
    throw new Error(`summary.html 파일을 찾지 못했습니다: ${inputHtml}`);
  }

  fs.mkdirSync(path.dirname(outputPdf), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
    await page.goto(`file://${inputHtml}`, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(250);
    await page.pdf({
      path: outputPdf,
      format: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: '10mm', right: '8mm', bottom: '10mm', left: '8mm' },
    });
  } finally {
    await browser.close();
  }

  return { inputHtml, outputPdf };
}

async function main() {
  const result = await generateSummaryPdf({
    inputHtml: process.argv[2],
    outputPdf: process.argv[3],
  });
  console.log(`PDF 생성 완료: ${result.outputPdf}`);
}

module.exports = {
  generateSummaryPdf,
  resolvePath,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
