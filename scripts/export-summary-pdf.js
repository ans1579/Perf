const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { resolveLatestPerfDir } = require('./_output-dir');

function isTruthy(value) {
  return /^(1|true|yes|y|on)$/i.test(String(value ?? '').trim());
}

function resolvePath(p, fallback, cwd = process.cwd()) {
  const raw = (p || '').trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isUpToDate(inputHtml, outputPdf) {
  const input = statSafe(inputHtml);
  const output = statSafe(outputPdf);
  if (!input || !output || !input.isFile() || !output.isFile()) return false;
  if (output.size <= 0) return false;
  return output.mtimeMs >= input.mtimeMs;
}

async function generateSummaryPdf(options = {}) {
  const projectRoot = path.resolve(__dirname, '..');
  const cwd = options.cwd ?? projectRoot;
  const rootDir = path.resolve(cwd, 'test-output', 'perf-metrics');
  const latestDir = resolveLatestPerfDir(rootDir, options.runId);
  const defaultHtml = path.resolve(latestDir, 'summary.html');
  const defaultPdf = path.resolve(latestDir, 'summary.pdf');
  const force = options.force === true || isTruthy(process.env.PERF_PDF_FORCE);
  const parsedTimeout = Number(options.navTimeoutMs ?? process.env.PERF_PDF_NAV_TIMEOUT_MS ?? 30000);
  const navTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30000;

  const inputHtml = resolvePath(options.inputHtml, defaultHtml, cwd);
  const outputPdf = resolvePath(options.outputPdf, defaultPdf, cwd);

  if (!fs.existsSync(inputHtml)) {
    throw new Error(`summary.html 파일을 찾지 못했습니다: ${inputHtml}`);
  }

  if (!force && isUpToDate(inputHtml, outputPdf)) {
    return { inputHtml, outputPdf, skipped: true };
  }

  fs.mkdirSync(path.dirname(outputPdf), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
    await page.goto(`file://${inputHtml}`, {
      waitUntil: 'networkidle',
      timeout: navTimeoutMs,
    });
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

  return { inputHtml, outputPdf, skipped: false };
}

async function main() {
  const result = await generateSummaryPdf({
    inputHtml: process.argv[2],
    outputPdf: process.argv[3],
  });
  if (result.skipped) {
    console.log(`PDF 최신 상태 유지(생성 스킵): ${result.outputPdf}`);
    return;
  }
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
