const fs = require('node:fs');
const path = require('node:path');

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readLatestMeta(rootDir) {
  for (const fileName of ['latest-run.json', 'latest.json']) {
    const latestPath = path.join(rootDir, fileName);
    if (!fs.existsSync(latestPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      if (parsed && typeof parsed.outDir === 'string') return parsed;
    } catch {}
  }
  return null;
}

function hasSummaryHtml(dir) {
  if (!dir) return false;
  const st = statSafe(path.join(dir, 'summary.html'));
  return !!st && st.isFile() && st.size > 0;
}

function listCandidateRunDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(rootDir, entry.name);
    const st = statSafe(full);
    dirs.push({
      name: entry.name,
      full,
      mtimeMs: st ? st.mtimeMs : 0,
    });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs.map((d) => d.full);
}

function resolveLatestPerfDir(rootDir, preferredRunId) {
  const runId = (preferredRunId || process.env.PERF_RUN_ID || '').trim();
  if (runId) {
    const byRunId = path.join(rootDir, runId);
    if (hasSummaryHtml(byRunId)) return byRunId;
  }

  const latestDir = path.join(rootDir, 'latest');
  if (hasSummaryHtml(latestDir)) return latestDir;

  const latest = readLatestMeta(rootDir);
  if (latest && hasSummaryHtml(latest.outDir)) return latest.outDir;

  if (hasSummaryHtml(rootDir)) return rootDir;

  for (const dir of listCandidateRunDirs(rootDir)) {
    if (hasSummaryHtml(dir)) return dir;
  }

  return rootDir;
}

module.exports = {
  resolveLatestPerfDir,
};
