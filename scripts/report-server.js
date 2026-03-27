const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { generateSummaryPdf } = require('./export-summary-pdf');

const host = process.env.PERF_REPORT_HOST ?? '127.0.0.1';
const port = Number(process.env.PERF_REPORT_PORT ?? 9324);
const baseDir = path.resolve(process.cwd(), 'test-output', 'perf-metrics');
let inFlightPdfJob = null;

function isTruthy(value) {
  return /^(1|true|yes|y|on)$/i.test(String(value ?? '').trim());
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

function resolveSafePath(root, requestPath) {
  const normalized = path.posix.normalize(`/${requestPath}`).replace(/^\/+/, '');
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

async function serveFile(res, filePath, headOnly) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });

  if (headOnly) {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  });
  stream.pipe(res);
}

async function handleGeneratePdf(res, force = false) {
  const inputHtml = path.join(baseDir, 'summary.html');
  const outputPdf = path.join(baseDir, 'summary.pdf');

  try {
    if (!inFlightPdfJob) {
      inFlightPdfJob = generateSummaryPdf({ inputHtml, outputPdf, cwd: process.cwd(), force })
        .finally(() => {
          inFlightPdfJob = null;
        });
    }

    const result = await inFlightPdfJob;
    sendJson(res, 200, {
      ok: true,
      file: '/summary.pdf',
      generatedAt: new Date().toISOString(),
      skipped: Boolean(result?.skipped),
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const hostHeader = req.headers.host || `${host}:${port}`;
  const url = new URL(req.url || '/', `http://${hostHeader}`);

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, baseDir });
    return;
  }

  if (url.pathname === '/api/report/pdf') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    await handleGeneratePdf(res, isTruthy(url.searchParams.get('force')));
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const requested = url.pathname === '/' ? '/summary.html' : url.pathname;
  const fullPath = resolveSafePath(baseDir, requested);
  if (!fullPath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  await serveFile(res, fullPath, method === 'HEAD');
});

server.listen(port, host, () => {
  console.log(`[report-server] listening: http://${host}:${port}`);
  console.log(`[report-server] base dir: ${baseDir}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
