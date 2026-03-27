import fs from 'node:fs';
import path from 'node:path';
import type { PerfPlatform } from './appium';

type MetricCategory = 'e2e' | 'memory' | 'cpu' | 'current';

type MetricLine = {
  category: MetricCategory;
  platform: PerfPlatform;
  device: string;
  target: string;
  name: string;
  value: number;
  unit: string;
  ts: string;
};

type Point = { value: number; ts: number };
type CaseByTarget = {
  e2eMs?: Point;
  memoryDeltaMB?: Point;
  cpuAvgPct?: Point;
  currentAvgmA?: Point;
};

type CaseBucket = Map<string, CaseByTarget>;
type MetricKey = 'e2eMs' | 'memoryDeltaMB' | 'cpuAvgPct' | 'currentAvgmA';

type CompareRow = {
  caseNo: string;
  caseName: string;
  metric: MetricKey;
  values: Record<string, number | null>;
};

type StatRow = {
  caseNo: string;
  caseName: string;
  metric: MetricKey;
  target: string;
  count: number;
  min: number | null;
  p5: number | null;
  avg: number | null;
  p95: number | null;
  max: number | null;
};

const OUT_DIR = path.join(process.cwd(), 'test-output', 'perf-metrics');
const JSONL_PATH = path.join(OUT_DIR, 'metrics.jsonl');
const SUMMARY_CSV = path.join(OUT_DIR, 'summary.csv');
const SUMMARY_RAW_CSV = path.join(OUT_DIR, 'summary_raw.csv');
const SUMMARY_STATS_CSV = path.join(OUT_DIR, 'summary_stats.csv');
const SUMMARY_HTML = path.join(OUT_DIR, 'summary.html');
const SUMMARY_XLSX = path.join(OUT_DIR, 'summary.xlsx');
const SUMMARY_PDF = path.join(OUT_DIR, 'summary.pdf');
const SUMMARY_META = path.join(OUT_DIR, 'summary.meta.json');
const CASE_KEY_SEP = '\u0001';

type SummaryMeta = {
  sourceStamp: string;
  generatorStamp: string;
  generatedAt: string;
  device: string;
};

const GENERATOR_STAMP = (() => {
  try {
    const st = fs.statSync(__filename);
    return `${path.basename(__filename)}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return `${path.basename(__filename)}:unknown`;
  }
})();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toEpoch(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function toNum(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return Number(v);
}

function round(v: number | null, digits = 2): number | null {
  if (v === null) return null;
  return Number(v.toFixed(digits));
}

function parseCaseName(name: string): { caseNo: string; caseName: string; suffix: string } | null {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx >= name.length - 1) return null;
  const raw = name.slice(0, idx).trim();
  const sep = raw.indexOf('::');
  if (sep < 0) return { caseNo: '', caseName: raw, suffix: name.slice(idx + 1) };

  const caseNo = raw.slice(0, sep).trim();
  const caseName = raw.slice(sep + 2).trim();
  return {
    caseNo,
    caseName: caseName || raw,
    suffix: name.slice(idx + 1),
  };
}

function makeCaseKey(caseNo: string, caseName: string): string {
  return `${caseNo}${CASE_KEY_SEP}${caseName}`;
}

function splitCaseKey(key: string): { caseNo: string; caseName: string } {
  const idx = key.indexOf(CASE_KEY_SEP);
  if (idx < 0) return { caseNo: '', caseName: key };
  return { caseNo: key.slice(0, idx), caseName: key.slice(idx + 1) };
}

function toCaseOrderNum(caseNo: string): number | null {
  if (!/^\d+$/.test(caseNo)) return null;
  return Number(caseNo);
}

function compareCaseKey(a: string, b: string): number {
  const ca = splitCaseKey(a);
  const cb = splitCaseKey(b);
  const na = toCaseOrderNum(ca.caseNo);
  const nb = toCaseOrderNum(cb.caseNo);

  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;

  if (ca.caseNo !== cb.caseNo) return ca.caseNo.localeCompare(cb.caseNo, 'ko');
  return ca.caseName.localeCompare(cb.caseName, 'ko');
}

function readMetrics(): MetricLine[] {
  if (!fs.existsSync(JSONL_PATH)) return [];
  const lines = fs
    .readFileSync(JSONL_PATH, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const out: MetricLine[] = [];
  for (const line of lines) {
    try {
      const m = JSON.parse(line) as MetricLine;
      if (!m?.category || !m?.target || !m?.name || !m?.device) continue;
      out.push(m);
    } catch {}
  }
  return out;
}

function pickDevice(metrics: MetricLine[]): string {
  const byEnv = (process.env.PERF_SUMMARY_DEVICE_NAME ?? '').trim();
  if (byEnv) return byEnv;
  if (metrics.length === 0) return 'UNKNOWN_DEVICE';

  let latestTs = Number.NEGATIVE_INFINITY;
  let latestDevice = metrics[metrics.length - 1]?.device ?? metrics[0].device;
  for (const m of metrics) {
    const ts = toEpoch(m.ts);
    if (ts >= latestTs) {
      latestTs = ts;
      latestDevice = m.device;
    }
  }
  return latestDevice;
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|y|on)$/i.test((value ?? '').trim());
}

function buildMetricsSourceStamp(): string | null {
  try {
    const st = fs.statSync(JSONL_PATH);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

function readSummaryMeta(): SummaryMeta | null {
  if (!fs.existsSync(SUMMARY_META)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(SUMMARY_META, 'utf8')) as Partial<SummaryMeta>;
    if (!parsed || typeof parsed.sourceStamp !== 'string' || typeof parsed.generatorStamp !== 'string') return null;
    return {
      sourceStamp: parsed.sourceStamp,
      generatorStamp: parsed.generatorStamp,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      device: typeof parsed.device === 'string' ? parsed.device : '',
    };
  } catch {
    return null;
  }
}

function writeSummaryMeta(meta: SummaryMeta) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

function hasRequiredSummaryOutputs(): boolean {
  return [SUMMARY_CSV, SUMMARY_RAW_CSV, SUMMARY_STATS_CSV, SUMMARY_HTML, SUMMARY_PDF].every((f) => fs.existsSync(f));
}

function setLatest(target: CaseByTarget, key: keyof CaseByTarget, next: Point) {
  const prev = target[key];
  if (!prev || next.ts >= prev.ts) target[key] = next;
}

function collectTargetOrder(metrics: MetricLine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of metrics) {
    if (!seen.has(m.target)) {
      seen.add(m.target);
      out.push(m.target);
    }
  }
  return out;
}

function buildCases(metrics: MetricLine[]): { cases: Map<string, CaseBucket>; targets: string[] } {
  const cases = new Map<string, CaseBucket>();
  const targets = collectTargetOrder(metrics);

  for (const m of metrics) {
    const parsed = parseCaseName(m.name);
    if (!parsed) continue;
    const value = toNum(m.value);
    if (value === null) continue;

    const { caseNo, caseName, suffix } = parsed;
    const caseKey = makeCaseKey(caseNo, caseName);
    const byTarget = cases.get(caseKey) ?? new Map<string, CaseByTarget>();
    const bucket = byTarget.get(m.target) ?? {};
    const p: Point = { value, ts: toEpoch(m.ts) };

    if (m.category === 'e2e' && suffix === 'duration') setLatest(bucket, 'e2eMs', p);
    if (m.category === 'memory' && suffix === 'delta') setLatest(bucket, 'memoryDeltaMB', p);
    if (m.category === 'cpu' && suffix === 'avg') setLatest(bucket, 'cpuAvgPct', p);
    if (m.category === 'current' && suffix === 'avg') setLatest(bucket, 'currentAvgmA', p);

    byTarget.set(m.target, bucket);
    cases.set(caseKey, byTarget);
  }

  return { cases, targets };
}

function makeRows(cases: Map<string, CaseBucket>, targets: string[]): CompareRow[] {
  const rows: CompareRow[] = [];
  const defs: MetricKey[] = ['e2eMs', 'memoryDeltaMB', 'cpuAvgPct', 'currentAvgmA'];

  for (const caseKey of [...cases.keys()].sort(compareCaseKey)) {
    const byTarget = cases.get(caseKey)!;
    const { caseNo, caseName } = splitCaseKey(caseKey);
    for (const metric of defs) {
      const values: Record<string, number | null> = {};
      for (const t of targets) {
        const v = byTarget.get(t)?.[metric]?.value;
        values[t] = v === undefined ? null : round(v, 2);
      }
      rows.push({
        caseNo,
        caseName,
        metric,
        values,
      });
    }
  }
  return rows;
}

function metricLabel(metric: MetricKey): string {
  if (metric === 'e2eMs') return 'E2E (ms)';
  if (metric === 'memoryDeltaMB') return 'Memory Delta (MB)';
  if (metric === 'cpuAvgPct') return 'CPU Avg (%)';
  return 'Current Avg (mA)';
}

function metricLabelKo(metric: MetricKey): string {
  if (metric === 'e2eMs') return 'E2E 응답시간';
  if (metric === 'memoryDeltaMB') return '메모리 변화량';
  if (metric === 'cpuAvgPct') return 'CPU 평균 사용률';
  return '평균 전류';
}

function metricUnit(metric: MetricKey): string {
  if (metric === 'e2eMs') return 'ms';
  if (metric === 'memoryDeltaMB') return 'MB';
  if (metric === 'cpuAvgPct') return '%';
  return 'mA';
}

function escapeCsv(value: string) {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvValue(v: number | string | null) {
  return v === null ? '' : String(v);
}

function bestLower(values: Record<string, number | null>, targets: string[]): { target: string; value: number } | null {
  let best: { target: string; value: number } | null = null;
  for (const t of targets) {
    const v = values[t];
    if (v === null) continue;
    if (!best || v < best.value) best = { target: t, value: v };
  }
  return best;
}

function worstLower(values: Record<string, number | null>, targets: string[]): { target: string; value: number } | null {
  let worst: { target: string; value: number } | null = null;
  for (const t of targets) {
    const v = values[t];
    if (v === null) continue;
    if (!worst || v > worst.value) worst = { target: t, value: v };
  }
  return worst;
}

function metricRankText(values: Record<string, number | null>, targets: string[]): string {
  const items = targets
    .map((t) => ({ t, v: values[t] }))
    .filter((x): x is { t: string; v: number } => x.v !== null)
    .sort((a, b) => a.v - b.v);
  return items.map((x, i) => `${i + 1}위 ${x.t}(${x.v})`).join(' / ');
}

function rowSpread(values: Record<string, number | null>, targets: string[]): { abs: number | null; pct: number | null } {
  const nums = targets.map((t) => values[t]).filter((v): v is number => v !== null);
  if (nums.length === 0) return { abs: null, pct: null };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const abs = Number((max - min).toFixed(2));
  const pct = min === 0 ? null : Number((((max - min) / Math.abs(min)) * 100).toFixed(2));
  return { abs, pct };
}

function verdictByDiff(diff: number): string {
  if (diff < 0) return '우수';
  if (diff > 0) return '열위';
  return '동일';
}

function repeatReliabilityLabel(count: number): string {
  if (count >= 10) return '높음';
  if (count >= 5) return '보통';
  if (count >= 3) return '낮음';
  return '매우 낮음';
}

function repeatReliabilityTone(count: number): 'good' | 'mid' | 'bad' {
  if (count >= 10) return 'good';
  if (count >= 5) return 'mid';
  return 'bad';
}

function writeCsvLines(filePath: string, rows: string[][]) {
  const body = rows.map((cols) => cols.map(escapeCsv).join(',')).join('\r\n');
  const bom = '\uFEFF';
  fs.writeFileSync(filePath, `${bom}${body}\r\n`, 'utf8');
}

function writeSummaryRawCsv(device: string, rows: CompareRow[], targets: string[]) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const headers = ['device', 'caseNo', 'caseName', 'metric', ...targets];
  const lines: string[][] = [headers];

  for (const row of rows) {
    const vals = targets.map((t) => toCsvValue(row.values[t]));
    lines.push([device, row.caseNo, row.caseName, row.metric, ...vals.map(String)]);
  }
  writeCsvLines(SUMMARY_RAW_CSV, lines);
}

function writeSummaryCsv(device: string, rows: CompareRow[], targets: string[]) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const lines: string[][] = [];
  const now = new Date();
  const nowUtc = now.toISOString();
  const nowKst = now.toLocaleString('sv-SE', {
    timeZone: 'Asia/Seoul',
    hour12: false,
  }).replace(' ', 'T');
  const baseline = targets[0] ?? '';

  lines.push(['section', '요약 정보']);
  lines.push(['항목', '값']);
  lines.push(['생성시각(KST)', nowKst]);
  lines.push(['생성시각(UTC)', nowUtc]);
  lines.push(['단말', device]);
  lines.push(['비교 앱 목록', targets.join(' | ')]);
  lines.push(['비교 기준', '수치가 낮을수록 우수']);
  lines.push([]);

  lines.push(['section', '1) 지표 평균 요약 (낮을수록 우수)']);
  lines.push(['지표', '단위', ...targets, '1등(최저)', '꼴등(최고)', '최대-최소', '격차(%)', '순위']);
  const metrics: MetricKey[] = ['e2eMs', 'memoryDeltaMB', 'cpuAvgPct', 'currentAvgmA'];
  for (const metric of metrics) {
    const values = metricAverages(rows, targets, metric);
    const best = bestLower(values, targets);
    const worst = worstLower(values, targets);
    const spread = rowSpread(values, targets);
    lines.push([
      metricLabelKo(metric),
      metricUnit(metric),
      ...targets.map((t) => toCsvValue(values[t]).toString()),
      best ? `${best.target}(${best.value})` : '',
      worst ? `${worst.target}(${worst.value})` : '',
      toCsvValue(spread.abs).toString(),
      spread.pct === null ? '' : `${spread.pct}%`,
      metricRankText(values, targets),
    ]);
  }
  lines.push([]);

  lines.push(['section', '2) 케이스별 스냅샷 비교 (낮을수록 우수)']);
  lines.push(['번호', '케이스', '지표', '단위', ...targets, '1등(최저)', '꼴등(최고)', '최대-최소', '격차(%)', '순위']);
  for (const row of rows) {
    const best = bestLower(row.values, targets);
    const worst = worstLower(row.values, targets);
    const spread = rowSpread(row.values, targets);
    lines.push([
      row.caseNo,
      row.caseName,
      metricLabelKo(row.metric),
      metricUnit(row.metric),
      ...targets.map((t) => toCsvValue(row.values[t]).toString()),
      best ? `${best.target}(${best.value})` : '',
      worst ? `${worst.target}(${worst.value})` : '',
      toCsvValue(spread.abs).toString(),
      spread.pct === null ? '' : `${spread.pct}%`,
      metricRankText(row.values, targets),
    ]);
  }
  lines.push([]);

  lines.push(['section', `3) 기준 앱 대비 차이 (기준: ${baseline || '-'})`]);
  lines.push(['번호', '케이스', '지표', '단위', '비교앱', '기준값', '비교값', '차이(비교-기준)', '차이율(%)', '판정']);
  for (const row of rows) {
    if (!baseline) break;
    const baseVal = row.values[baseline];
    if (baseVal === null) continue;
    for (const t of targets) {
      if (t === baseline) continue;
      const v = row.values[t];
      if (v === null) continue;
      const diff = Number((v - baseVal).toFixed(2));
      const pct = baseVal === 0 ? null : Number((((v - baseVal) / Math.abs(baseVal)) * 100).toFixed(2));
      lines.push([
        row.caseNo,
        row.caseName,
        metricLabelKo(row.metric),
        metricUnit(row.metric),
        t,
        String(baseVal),
        String(v),
        String(diff),
        pct === null ? '' : `${pct}%`,
        verdictByDiff(diff),
      ]);
    }
  }

  writeCsvLines(SUMMARY_CSV, lines);
}

function metricOrder(metric: MetricKey): number {
  if (metric === 'e2eMs') return 0;
  if (metric === 'memoryDeltaMB') return 1;
  if (metric === 'cpuAvgPct') return 2;
  return 3;
}

function toMetricKey(category: MetricCategory, suffix: string): MetricKey | null {
  if (category === 'e2e' && suffix === 'duration') return 'e2eMs';
  if (category === 'memory' && suffix === 'delta') return 'memoryDeltaMB';
  if (category === 'cpu' && suffix === 'avg') return 'cpuAvgPct';
  if (category === 'current' && suffix === 'avg') return 'currentAvgmA';
  return null;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const pos = (sortedAsc.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  const current = sortedAsc[base];
  const next = sortedAsc[base + 1] ?? current;
  return Number((current + (next - current) * rest).toFixed(2));
}

function buildStatRows(metrics: MetricLine[], targets: string[]): StatRow[] {
  const targetOrder = new Map(targets.map((t, i) => [t, i]));
  const grouped = new Map<string, number[]>();
  const meta = new Map<string, { caseKey: string; caseNo: string; caseName: string; metric: MetricKey; target: string }>();

  for (const m of metrics) {
    const parsed = parseCaseName(m.name);
    if (!parsed) continue;
    const value = toNum(m.value);
    if (value === null) continue;
    const metric = toMetricKey(m.category, parsed.suffix);
    if (!metric) continue;

    const caseKey = makeCaseKey(parsed.caseNo, parsed.caseName);
    const key = `${caseKey}${CASE_KEY_SEP}${metric}${CASE_KEY_SEP}${m.target}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(value);
    grouped.set(key, bucket);
    meta.set(key, {
      caseKey,
      caseNo: parsed.caseNo,
      caseName: parsed.caseName,
      metric,
      target: m.target,
    });
  }

  const rows: StatRow[] = [];
  for (const [key, nums] of grouped.entries()) {
    const info = meta.get(key);
    if (!info || nums.length === 0) continue;
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    rows.push({
      caseNo: info.caseNo,
      caseName: info.caseName,
      metric: info.metric,
      target: info.target,
      count: sorted.length,
      min: round(sorted[0], 2),
      p5: percentile(sorted, 0.05),
      avg: round(sum / sorted.length, 2),
      p95: percentile(sorted, 0.95),
      max: round(sorted[sorted.length - 1], 2),
    });
  }

  rows.sort((a, b) => {
    const c = compareCaseKey(makeCaseKey(a.caseNo, a.caseName), makeCaseKey(b.caseNo, b.caseName));
    if (c !== 0) return c;
    const m = metricOrder(a.metric) - metricOrder(b.metric);
    if (m !== 0) return m;
    return (targetOrder.get(a.target) ?? 999) - (targetOrder.get(b.target) ?? 999);
  });

  return rows;
}

function writeSummaryStatsCsv(device: string, rows: StatRow[]) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const nowKst = new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Seoul',
    hour12: false,
  }).replace(' ', 'T');

  const lines: string[][] = [
    ['section', '반복 실행 통계'],
    ['항목', '값'],
    ['생성시각(KST)', nowKst],
    ['단말', device],
    ['해석 가이드', 'p5/p95는 극단값 영향을 줄인 분포 범위입니다. n(반복횟수)이 많을수록 신뢰도가 높습니다.'],
    [],
    [
    '단말',
    '번호',
    '케이스',
    '지표',
    '단위',
    '앱',
    '반복횟수',
    'min',
    'p5',
    'avg',
    'p95',
    'max',
    '변동폭(max-min)',
    '중앙구간폭(p95-p5)',
    '신뢰도',
  ]];

  for (const row of rows) {
    const spread = row.max !== null && row.min !== null ? Number((row.max - row.min).toFixed(2)) : null;
    const midSpread = row.p95 !== null && row.p5 !== null ? Number((row.p95 - row.p5).toFixed(2)) : null;
    lines.push([
      device,
      row.caseNo,
      row.caseName,
      metricLabelKo(row.metric),
      metricUnit(row.metric),
      row.target,
      String(row.count),
      toCsvValue(row.min),
      toCsvValue(row.p5),
      toCsvValue(row.avg),
      toCsvValue(row.p95),
      toCsvValue(row.max),
      toCsvValue(spread),
      toCsvValue(midSpread),
      repeatReliabilityLabel(row.count),
    ].map((v) => String(v)));
  }
  writeCsvLines(SUMMARY_STATS_CSV, lines);
}

function toDisplayMetric(metric: MetricKey): string {
  return `${metricLabelKo(metric)} (${metricUnit(metric)})`;
}

function colName(index1Based: number): string {
  let n = index1Based;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

function cellLen(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number') return String(value).length;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'object' && 'richText' in (value as Record<string, unknown>)) {
    const rich = (value as { richText: Array<{ text?: string }> }).richText ?? [];
    return rich.map((r) => r.text ?? '').join('').length;
  }
  return String(value).length;
}

function autoFitColumns(ws: any, min = 10, max = 42) {
  ws.columns.forEach((col: any) => {
    let width = min;
    col.eachCell({ includeEmpty: true }, (cell: any) => {
      width = Math.max(width, cellLen(cell.value) + 2);
    });
    col.width = Math.min(max, width);
  });
}

function rankItems(values: Record<string, number | null>, targets: string[]) {
  return targets
    .map((t) => ({ target: t, value: values[t] }))
    .filter((x): x is { target: string; value: number } => x.value !== null)
    .sort((a, b) => a.value - b.value);
}

function baselineState(values: Record<string, number | null>, targets: string[], baseline: string) {
  if (!baseline) return { text: '기준 미지정', tone: 'muted' as const };
  const ranked = rankItems(values, targets);
  if (ranked.length === 0) return { text: '데이터 없음', tone: 'muted' as const };
  const idx = ranked.findIndex((x) => x.target === baseline);
  if (idx < 0) return { text: '기준값 없음', tone: 'muted' as const };
  if (idx === 0) return { text: '우수', tone: 'good' as const };
  if (idx === ranked.length - 1) return { text: '개선 필요', tone: 'bad' as const };
  return { text: '보통', tone: 'mid' as const };
}

function toneFill(tone: 'good' | 'bad' | 'mid' | 'muted') {
  if (tone === 'good') return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F8EE' } } as const;
  if (tone === 'bad') return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFECEC' } } as const;
  if (tone === 'mid') return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5E6' } } as const;
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F7FA' } } as const;
}

async function writeSummaryXlsx(device: string, rows: CompareRow[], targets: string[], statRows: StatRow[]) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const exceljsMod: any = await import('exceljs');
  const WorkbookCtor = exceljsMod.Workbook ?? exceljsMod.default?.Workbook;
  if (!WorkbookCtor) throw new Error('exceljs Workbook 로드 실패');
  const wb = new WorkbookCtor();
  wb.creator = 'perf-reporter';
  wb.created = new Date();
  wb.modified = new Date();

  const baseline = targets[0] ?? '';
  const baselineTargetIndex = baseline ? targets.findIndex((t) => t === baseline) : -1;
  const metrics: MetricKey[] = ['e2eMs', 'memoryDeltaMB', 'cpuAvgPct', 'currentAvgmA'];
  const borderThin = {
    top: { style: 'thin' as const, color: { argb: 'FFD9E2EF' } },
    left: { style: 'thin' as const, color: { argb: 'FFD9E2EF' } },
    bottom: { style: 'thin' as const, color: { argb: 'FFD9E2EF' } },
    right: { style: 'thin' as const, color: { argb: 'FFD9E2EF' } },
  };

  const ws1 = wb.addWorksheet('한눈요약', { views: [{ state: 'frozen', ySplit: 6 }] });
  const avgHeaders = ['지표', '단위', ...targets, '1등(최저)', '꼴등(최고)', '최대-최소', '격차(%)', '순위', '기준앱 상태'];
  ws1.mergeCells(`A1:${colName(avgHeaders.length)}1`);
  ws1.getCell('A1').value = '성능 비교 요약 보고서';
  ws1.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1F2A44' } };
  ws1.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };
  ws1.getRow(1).height = 24;

  ws1.addRow(['생성시각(KST)', new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul', hour12: false }).replace(' ', 'T')]);
  ws1.addRow(['단말', device]);
  ws1.addRow(['비교 앱', targets.join(' | ')]);
  ws1.addRow(['비교 기준', '수치가 낮을수록 우수']);

  for (let r = 2; r <= 5; r += 1) {
    ws1.getCell(r, 1).font = { bold: true, color: { argb: 'FF43506A' } };
    ws1.getCell(r, 2).font = { color: { argb: 'FF1E293B' } };
  }

  const headerRow1 = ws1.addRow(avgHeaders);
  headerRow1.eachCell((cell: any, idx: number) => {
    cell.font = { bold: true, color: { argb: 'FF334155' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1FF' } };
    cell.border = borderThin;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    if (baselineTargetIndex >= 0 && idx === 3 + baselineTargetIndex) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEBFF' } };
      cell.font = { bold: true, color: { argb: 'FF1D4ED8' } };
    }
  });

  for (const metric of metrics) {
    const values = metricAverages(rows, targets, metric);
    const best = bestLower(values, targets);
    const worst = worstLower(values, targets);
    const spread = rowSpread(values, targets);
    const status = baselineState(values, targets, baseline);
    const rank = metricRankText(values, targets);
    const data = [
      metricLabelKo(metric),
      metricUnit(metric),
      ...targets.map((t) => values[t]),
      best ? `${best.target} (${best.value})` : '',
      worst ? `${worst.target} (${worst.value})` : '',
      spread.abs,
      spread.pct === null ? '' : `${spread.pct}%`,
      rank,
      status.text,
    ];
    const row = ws1.addRow(data);
    row.eachCell((cell: any, idx: number) => {
      cell.border = borderThin;
      if (idx >= 3 && idx < 3 + targets.length && typeof cell.value === 'number') {
        cell.numFmt = '0.00';
      }
      if (idx === avgHeaders.length) {
        cell.fill = toneFill(status.tone);
        cell.font = { bold: true, color: { argb: 'FF1F2A44' } };
      }
    });
    if (best) {
      const idx = targets.findIndex((t) => t === best.target);
      if (idx >= 0) ws1.getCell(row.number, 3 + idx).fill = toneFill('good');
    }
    if (worst) {
      const idx = targets.findIndex((t) => t === worst.target);
      if (idx >= 0) ws1.getCell(row.number, 3 + idx).fill = toneFill('bad');
    }
  }

  ws1.addRow([]);
  const note = ws1.addRow(['해석 가이드', '1등(최저)과 기준앱 상태(우수/보통/개선 필요)만 먼저 보면 핵심 판단이 가능합니다.']);
  note.getCell(1).font = { bold: true, color: { argb: 'FF475569' } };
  note.getCell(2).font = { color: { argb: 'FF64748B' } };
  autoFitColumns(ws1, 10, 46);

  const ws2 = wb.addWorksheet('케이스비교', { views: [{ state: 'frozen', ySplit: 1 }] });
  const caseHeaders = ['번호', '케이스', '지표', '단위', ...targets, '1등(최저)', '꼴등(최고)', '최대-최소', '격차(%)', '순위'];
  const caseHeader = ws2.addRow(caseHeaders);
  caseHeader.eachCell((cell: any, idx: number) => {
    cell.font = { bold: true, color: { argb: 'FF334155' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1FF' } };
    cell.border = borderThin;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    if (baselineTargetIndex >= 0 && idx === 5 + baselineTargetIndex) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEBFF' } };
      cell.font = { bold: true, color: { argb: 'FF1D4ED8' } };
    }
  });

  for (const rowData of rows) {
    const best = bestLower(rowData.values, targets);
    const worst = worstLower(rowData.values, targets);
    const spread = rowSpread(rowData.values, targets);
    const data = [
      rowData.caseNo,
      rowData.caseName,
      metricLabelKo(rowData.metric),
      metricUnit(rowData.metric),
      ...targets.map((t) => rowData.values[t]),
      best ? `${best.target} (${best.value})` : '',
      worst ? `${worst.target} (${worst.value})` : '',
      spread.abs,
      spread.pct === null ? '' : `${spread.pct}%`,
      metricRankText(rowData.values, targets),
    ];
    const row = ws2.addRow(data);
    row.eachCell((cell: any, idx: number) => {
      cell.border = borderThin;
      if (idx >= 5 && idx < 5 + targets.length && typeof cell.value === 'number') {
        cell.numFmt = '0.00';
      }
    });
    if (best) {
      const idx = targets.findIndex((t) => t === best.target);
      if (idx >= 0) ws2.getCell(row.number, 5 + idx).fill = toneFill('good');
    }
    if (worst) {
      const idx = targets.findIndex((t) => t === worst.target);
      if (idx >= 0) ws2.getCell(row.number, 5 + idx).fill = toneFill('bad');
    }
  }
  autoFitColumns(ws2, 10, 46);

  const ws3 = wb.addWorksheet('반복통계', { views: [{ state: 'frozen', ySplit: 1 }] });
  const statHeaders = ['번호', '케이스', '지표', '단위', '앱', '반복횟수', 'min', 'p5', 'avg', 'p95', 'max', '변동폭(max-min)', '중앙구간폭(p95-p5)', '신뢰도'];
  const statHeader = ws3.addRow(statHeaders);
  statHeader.eachCell((cell: any) => {
    cell.font = { bold: true, color: { argb: 'FF334155' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1FF' } };
    cell.border = borderThin;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  for (const row of statRows) {
    const spread = row.max !== null && row.min !== null ? Number((row.max - row.min).toFixed(2)) : null;
    const midSpread = row.p95 !== null && row.p5 !== null ? Number((row.p95 - row.p5).toFixed(2)) : null;
    const reliability = repeatReliabilityLabel(row.count);
    const reliabilityTone = repeatReliabilityTone(row.count);
    const rowExcel = ws3.addRow([
      row.caseNo,
      row.caseName,
      metricLabelKo(row.metric),
      metricUnit(row.metric),
      row.target,
      row.count,
      row.min,
      row.p5,
      row.avg,
      row.p95,
      row.max,
      spread,
      midSpread,
      reliability,
    ]);
    rowExcel.eachCell((cell: any, idx: number) => {
      cell.border = borderThin;
      if (idx >= 7 && idx <= 13 && typeof cell.value === 'number') {
        cell.numFmt = '0.00';
      }
    });
    const reliabilityCell = ws3.getCell(rowExcel.number, 14);
    reliabilityCell.fill = toneFill(reliabilityTone);
    reliabilityCell.font = { bold: true, color: { argb: 'FF334155' } };
  }
  autoFitColumns(ws3, 10, 46);

  await wb.xlsx.writeFile(SUMMARY_XLSX);
}

function avg(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
}

function summarizeRepeatReliability(statRows: StatRow[]): { label: string; detail: string; tone: 'good' | 'mid' | 'bad' | 'muted' } {
  const counts = statRows.map((r) => r.count).filter((n) => Number.isFinite(n) && n > 0);
  if (counts.length === 0) {
    return { label: '데이터 없음', detail: '반복 통계가 아직 없습니다.', tone: 'muted' };
  }

  const min = Math.min(...counts);
  const avgCount = Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1));
  const max = Math.max(...counts);
  const label = repeatReliabilityLabel(min);
  const tone = repeatReliabilityTone(min);
  return {
    label,
    tone,
    detail: `최소 n=${min}, 평균 n=${avgCount}, 최대 n=${max}`,
  };
}

function format(v: number | null, unit = '') {
  return v === null ? '-' : `${v}${unit}`;
}

function metricAverages(rows: CompareRow[], targets: string[], metric: MetricKey): Record<string, number | null> {
  const filtered = rows.filter((r) => r.metric === metric);
  const out: Record<string, number | null> = {};
  for (const t of targets) {
    out[t] = avg(filtered.map((r) => r.values[t]));
  }
  return out;
}

function renderCard(title: string, values: Record<string, number | null>, colorMap: Record<string, string>) {
  const items = Object.entries(values)
    .map(
      ([k, v]) => `
      <div class="kv">
        <span class="dot" style="background:${colorMap[k] ?? '#64748b'}"></span>
        <span class="name">${escapeHtml(k)}</span>
        <span class="num">${format(v)}</span>
      </div>`
    )
    .join('');
  return `
  <div class="card">
    <div class="k">${title}</div>
    <div class="v-list">${items}</div>
  </div>`;
}

function colors(targets: string[]): Record<string, string> {
  const palette = ['#2563eb', '#16a34a', '#f59e0b', '#8b5cf6', '#ef4444', '#0ea5e9'];
  const out: Record<string, string> = {};
  targets.forEach((t, i) => {
    out[t] = palette[i % palette.length];
  });
  return out;
}

function buildInsight(metric: MetricKey, values: Record<string, number | null>, targets: string[], baseline: string) {
  const title = toDisplayMetric(metric);
  const ranked = rankItems(values, targets);
  if (ranked.length === 0) {
    return { title, tone: 'muted' as const, text: '데이터가 없어 판단할 수 없습니다.' };
  }
  if (!baseline) {
    const best = ranked[0];
    return { title, tone: 'muted' as const, text: `최저값은 ${best.target} (${best.value})입니다.` };
  }

  const base = ranked.find((x) => x.target === baseline);
  const best = ranked[0];
  if (!base) {
    return { title, tone: 'muted' as const, text: `기준 앱(${baseline}) 데이터가 없습니다.` };
  }

  const rank = ranked.findIndex((x) => x.target === baseline) + 1;
  const total = ranked.length;
  if (rank === 1) {
    return {
      title,
      tone: 'good' as const,
      text: `${baseline}이 ${total}개 앱 중 1위(최저)입니다.`,
    };
  }
  const diff = Number((base.value - best.value).toFixed(2));
  const diffPct = best.value === 0 ? null : Number((((base.value - best.value) / Math.abs(best.value)) * 100).toFixed(2));
  if (rank === total) {
    return {
      title,
      tone: 'bad' as const,
      text: `${baseline}이 최하위입니다. 1위(${best.target}) 대비 +${diff}${metricUnit(metric)}${diffPct === null ? '' : ` (${diffPct}%)`} 높습니다.`,
    };
  }
  return {
    title,
    tone: 'mid' as const,
    text: `${baseline}이 ${rank}/${total}위입니다. 1위(${best.target}) 대비 +${diff}${metricUnit(metric)}${diffPct === null ? '' : ` (${diffPct}%)`} 높습니다.`,
  };
}

function renderInsights(rows: CompareRow[], targets: string[]) {
  const baseline = targets[0] ?? '';
  const metricKeys: MetricKey[] = ['e2eMs', 'memoryDeltaMB', 'cpuAvgPct', 'currentAvgmA'];
  const items = metricKeys
    .map((metric) => {
      const values = metricAverages(rows, targets, metric);
      const insight = buildInsight(metric, values, targets, baseline);
      return `<div class="insight-item ${insight.tone}">
        <div class="insight-title">${escapeHtml(insight.title)}</div>
        <div class="insight-text">${escapeHtml(insight.text)}</div>
      </div>`;
    })
    .join('');
  return `<section class="insight-wrap">${items}</section>`;
}

type MetricRange = {
  min: number;
  max: number;
  paddedMin: number;
  paddedMax: number;
};

type RunTrendMetricData = {
  metric: MetricKey;
  caseNo: string;
  caseName: string;
  maxRun: number;
  range: MetricRange;
  seriesByTarget: Record<string, number[]>;
};

function makeRangeFromNumbers(nums: number[]): MetricRange {
  if (nums.length === 0) return { min: 0, max: 0, paddedMin: 0, paddedMax: 1 };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  const pad = span === 0 ? Math.max(Math.abs(min) * 0.08, 1) : span * 0.08;
  return {
    min: round(min, 2) ?? min,
    max: round(max, 2) ?? max,
    paddedMin: min - pad,
    paddedMax: max + pad,
  };
}

function buildRunTrendData(metrics: MetricLine[], targets: string[]): Partial<Record<MetricKey, RunTrendMetricData>> {
  type RawPoint = { ts: number; value: number };
  type RawMeta = { metric: MetricKey; caseKey: string; caseNo: string; caseName: string; target: string };
  const raw = new Map<string, RawPoint[]>();
  const meta = new Map<string, RawMeta>();

  for (const m of metrics) {
    const parsed = parseCaseName(m.name);
    if (!parsed) continue;
    const value = toNum(m.value);
    if (value === null) continue;
    const metric = toMetricKey(m.category, parsed.suffix);
    if (!metric) continue;

    const caseKey = makeCaseKey(parsed.caseNo, parsed.caseName);
    const key = `${metric}${CASE_KEY_SEP}${caseKey}${CASE_KEY_SEP}${m.target}`;
    const bucket = raw.get(key) ?? [];
    bucket.push({ ts: toEpoch(m.ts), value });
    raw.set(key, bucket);
    meta.set(key, {
      metric,
      caseKey,
      caseNo: parsed.caseNo,
      caseName: parsed.caseName,
      target: m.target,
    });
  }

  const byMetricCase = new Map<string, number>();
  const keysByMetricCase = new Map<string, string[]>();

  for (const [key, points] of raw.entries()) {
    const m = meta.get(key);
    if (!m || points.length === 0) continue;
    const mcKey = `${m.metric}${CASE_KEY_SEP}${m.caseKey}`;
    byMetricCase.set(mcKey, (byMetricCase.get(mcKey) ?? 0) + points.length);
    const arr = keysByMetricCase.get(mcKey) ?? [];
    arr.push(key);
    keysByMetricCase.set(mcKey, arr);
  }

  const out: Partial<Record<MetricKey, RunTrendMetricData>> = {};
  const metricKeys: MetricKey[] = ['e2eMs', 'memoryDeltaMB', 'cpuAvgPct', 'currentAvgmA'];

  for (const metric of metricKeys) {
    const candidates = [...byMetricCase.entries()].filter(([k]) => k.startsWith(`${metric}${CASE_KEY_SEP}`));
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const caseA = a[0].slice(metric.length + CASE_KEY_SEP.length);
      const caseB = b[0].slice(metric.length + CASE_KEY_SEP.length);
      return compareCaseKey(caseA, caseB);
    });

    const selectedMetricCase = candidates[0][0];
    const selectedKeys = keysByMetricCase.get(selectedMetricCase) ?? [];
    const seriesByTarget: Record<string, number[]> = {};

    for (const t of targets) seriesByTarget[t] = [];

    for (const key of selectedKeys) {
      const m = meta.get(key);
      if (!m) continue;
      const sorted = [...(raw.get(key) ?? [])].sort((a, b) => a.ts - b.ts).map((p) => round(p.value, 2) ?? p.value);
      seriesByTarget[m.target] = sorted;
    }

    const firstMeta = meta.get(selectedKeys[0] ?? '');
    if (!firstMeta) continue;

    const allNums = Object.values(seriesByTarget).flat();
    const maxRun = Math.max(1, ...Object.values(seriesByTarget).map((s) => s.length));

    out[metric] = {
      metric,
      caseNo: firstMeta.caseNo,
      caseName: firstMeta.caseName,
      maxRun,
      range: makeRangeFromNumbers(allNums),
      seriesByTarget,
    };
  }

  return out;
}

function makeMetricRanges(rows: CompareRow[], targets: string[]): Record<MetricKey, MetricRange> {
  const keys: MetricKey[] = ['e2eMs', 'memoryDeltaMB', 'cpuAvgPct', 'currentAvgmA'];
  const out = {} as Record<MetricKey, MetricRange>;

  for (const key of keys) {
    const nums = rows
      .filter((r) => r.metric === key)
      .flatMap((r) => targets.map((t) => r.values[t]))
      .filter((v): v is number => v !== null);

    if (nums.length === 0) {
      out[key] = { min: 0, max: 0, paddedMin: 0, paddedMax: 1 };
      continue;
    }

    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min;
    const pad = span === 0 ? Math.max(Math.abs(min) * 0.08, 1) : span * 0.08;
    out[key] = {
      min: round(min, 2) ?? min,
      max: round(max, 2) ?? max,
      paddedMin: min - pad,
      paddedMax: max + pad,
    };
  }

  return out;
}

function percentDelta(base: number, value: number): string {
  if (base === 0) return '';
  const pct = ((value - base) / Math.abs(base)) * 100;
  return ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
}

function panel(
  metric: MetricKey,
  rows: CompareRow[],
  targets: string[],
  colorMap: Record<string, string>,
  ranges: Record<MetricKey, MetricRange>
) {
  const filtered = rows.filter((r) => r.metric === metric);
  const range = ranges[metric];
  const visualMin = Math.min(0, range.min);
  const visualMax = Math.max(0, range.max);
  const visualSpan = Math.max(1e-9, visualMax - visualMin);

  const body = filtered
    .map((r) => {
      const nums = targets.map((t) => r.values[t]).filter((v): v is number => v !== null);
      const rowMin = nums.length === 0 ? null : Math.min(...nums);
      const rowMax = nums.length === 0 ? null : Math.max(...nums);
      const rowRange = rowMin === null || rowMax === null ? null : rowMax - rowMin;
      const rowSpreadPct =
        rowMin === null || rowMax === null || rowMin === 0
          ? null
          : Math.abs(((rowMax - rowMin) / Math.abs(rowMin)) * 100);

      const cols = targets
        .map((t) => {
          const v = r.values[t];
          const h =
            v === null
              ? 0
              : visualSpan <= 0
                ? 50
                : Math.max(0, Math.min(100, Math.round(((v - visualMin) / visualSpan) * 100)));
          let deltaText = 'N/A';
          if (v !== null && rowMin !== null) {
            if (v === rowMin) deltaText = '기준';
            else deltaText = `+${(v - rowMin).toFixed(2)}${percentDelta(rowMin, v)}`;
          }
          return `
          <div class="v-col">
            <div class="v-value">${format(v)}</div>
            <div class="v-track"><div class="v-fill" style="height:${h}%;background:${colorMap[t]}"></div></div>
            <div class="v-label" style="color:${colorMap[t]}">${escapeHtml(t)}</div>
            <div class="v-delta">${deltaText}</div>
          </div>`;
        })
        .join('');
      return `
      <div class="bar-row">
        <div class="bar-head">
          <div class="bar-case">${escapeHtml(r.caseNo ? `${r.caseNo}. ${r.caseName}` : r.caseName)}</div>
          <div class="bar-meta">
            행 min ${format(rowMin === null ? null : round(rowMin, 2))}
            / max ${format(rowMax === null ? null : round(rowMax, 2))}
            / Δ ${format(rowRange === null ? null : round(rowRange, 2))}
            ${rowSpreadPct === null ? '' : `(${rowSpreadPct.toFixed(1)}%)`}
          </div>
        </div>
        <div class="v-chart">${cols}</div>
      </div>`;
    })
    .join('');

  return `
  <section class="panel">
    <h3>${metricLabel(metric)} <span class="axis-meta">(시각 축 ${format(round(visualMin, 2))} ~ ${format(
    round(visualMax, 2)
  )} / 실측 ${format(round(range.min, 2))} ~ ${format(round(range.max, 2))})</span></h3>
    ${body || '<div class="empty">데이터가 없습니다.</div>'}
  </section>`;
}

function buildTickIndexes(length: number): number[] {
  if (length <= 1) return [0];
  if (length <= 6) return [...Array(length).keys()];
  const points = [0, Math.floor((length - 1) * 0.25), Math.floor((length - 1) * 0.5), Math.floor((length - 1) * 0.75), length - 1];
  return [...new Set(points)];
}

function runTrendCard(metric: MetricKey, data: RunTrendMetricData | undefined, targets: string[], colorMap: Record<string, string>) {
  if (!data) {
    return `
    <section class="trend-card">
      <div class="trend-head">
        <h3>${metricLabel(metric)}</h3>
      </div>
      <div class="empty">반복 데이터가 없습니다.</div>
    </section>`;
  }

  const width = 560;
  const height = 220;
  const pad = { left: 40, right: 16, top: 16, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const span = data.range.paddedMax - data.range.paddedMin || 1;

  const x = (runIndex: number) =>
    data.maxRun <= 1 ? pad.left + plotW / 2 : pad.left + (runIndex / (data.maxRun - 1)) * plotW;
  const y = (value: number) => pad.top + (1 - (value - data.range.paddedMin) / span) * plotH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((r) => {
      const yy = pad.top + r * plotH;
      return `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" class="chart-grid" />`;
    })
    .join('');

  const targetLines = targets
    .map((t) => {
      const arr = data.seriesByTarget[t] ?? [];
      if (arr.length <= 1) return '';
      const points = arr.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      return `<polyline fill="none" stroke="${colorMap[t]}" stroke-width="2.2" points="${points}" />`;
    })
    .join('');

  const targetDots = targets
    .map((t) => {
      const arr = data.seriesByTarget[t] ?? [];
      return arr.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.2" fill="${colorMap[t]}" />`).join('');
    })
    .join('');

  const tickIndexes = buildTickIndexes(data.maxRun);
  const xLabels = tickIndexes
    .map((i) => `<text x="${x(i)}" y="${height - 10}" text-anchor="middle" class="axis-text">${i + 1}</text>`)
    .join('');

  const yTop = `<text x="${pad.left - 8}" y="${pad.top + 4}" text-anchor="end" class="axis-text">${format(
    round(data.range.max, 2)
  )}</text>`;
  const yBottom = `<text x="${pad.left - 8}" y="${height - pad.bottom + 4}" text-anchor="end" class="axis-text">${format(
    round(data.range.min, 2)
  )}</text>`;

  const latest = targets
    .map((t) => {
      const arr = data.seriesByTarget[t] ?? [];
      const last = arr.length > 0 ? arr[arr.length - 1] : null;
      return `<span class="latest-item"><i style="background:${colorMap[t]}"></i>${escapeHtml(t)} ${format(last)} (n=${arr.length})</span>`;
    })
    .join('');

  const caseTitle = data.caseNo ? `${data.caseNo}. ${data.caseName}` : data.caseName;
  return `
  <section class="trend-card">
    <div class="trend-head">
      <h3>${metricLabel(metric)}</h3>
      <div class="trend-sub">${escapeHtml(caseTitle)} · ${data.maxRun}회차 기준</div>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${metricLabel(metric)} run trend">
      ${gridLines}
      ${targetLines}
      ${targetDots}
      ${xLabels}
      ${yTop}
      ${yBottom}
    </svg>
    <div class="latest-row">${latest}</div>
  </section>`;
}

function writeSummaryHtml(
  device: string,
  rows: CompareRow[],
  targetList: string[],
  statRows: StatRow[],
  metrics: MetricLine[]
) {
  const c = colors(targetList);
  const ranges = makeMetricRanges(rows, targetList);
  const runTrends = buildRunTrendData(metrics, targetList);
  const reliability = summarizeRepeatReliability(statRows);
  const insightHtml = renderInsights(rows, targetList);
  const cards = {
    e2e: metricAverages(rows, targetList, 'e2eMs'),
    mem: metricAverages(rows, targetList, 'memoryDeltaMB'),
    cpu: metricAverages(rows, targetList, 'cpuAvgPct'),
    current: metricAverages(rows, targetList, 'currentAvgmA'),
  };

  const targetCols = targetList.map((t) => `<th>${escapeHtml(t)}</th>`).join('');
  const legend = targetList
    .map((t) => `<span class="legend-item"><i class="legend-dot" style="background:${c[t]}"></i>${escapeHtml(t)}</span>`)
    .join('');
  const tableRows =
    rows.length === 0
      ? `<tr><td colspan="${3 + targetList.length}">최신 스냅샷 데이터가 없습니다.</td></tr>`
      : rows
          .map((r) => {
            const nums = targetList.map((t) => r.values[t]).filter((v): v is number => v !== null);
            const rowMin = nums.length === 0 ? null : Math.min(...nums);
            const rowMax = nums.length === 0 ? null : Math.max(...nums);
            const vals = targetList
              .map((t) => {
                const v = r.values[t];
                const best = v !== null && rowMin !== null && v === rowMin;
                const worst = v !== null && rowMax !== null && rowMax !== rowMin && v === rowMax;
                const cls = best ? 'best' : worst ? 'worst' : '';
                return `<td${cls ? ` class="${cls}"` : ''}>${format(v)}</td>`;
              })
              .join('');
            return `<tr><td>${escapeHtml(r.caseNo)}</td><td>${escapeHtml(r.caseName)}</td><td><span class="metric-chip">${metricLabel(
              r.metric
            )}</span></td>${vals}</tr>`;
          })
          .join('\n');
  const statRowsHtml = statRows
    .map((r) => {
      const spread = r.max !== null && r.min !== null ? Number((r.max - r.min).toFixed(2)) : null;
      const midSpread = r.p95 !== null && r.p5 !== null ? Number((r.p95 - r.p5).toFixed(2)) : null;
      const reliabilityText = repeatReliabilityLabel(r.count);
      const reliabilityTone = repeatReliabilityTone(r.count);
      return `<tr>
        <td>${escapeHtml(r.caseNo)}</td>
        <td>${escapeHtml(r.caseName)}</td>
        <td><span class="metric-chip">${metricLabel(r.metric)}</span></td>
        <td>${escapeHtml(r.target)}</td>
        <td>${r.count}</td>
        <td>${format(r.min)}</td>
        <td>${format(r.p5)}</td>
        <td>${format(r.avg)}</td>
        <td>${format(r.p95)}</td>
        <td>${format(r.max)}</td>
        <td>${format(spread)}</td>
        <td>${format(midSpread)}</td>
        <td><span class="reliability-chip ${reliabilityTone}">${reliabilityText}</span></td>
      </tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Perf Summary Dashboard</title>
  <style>
    :root {
      --bg: #eef2f9;
      --card: #ffffff;
      --line: #d9e1ee;
      --text: #17223a;
      --muted: #5f6f8b;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #f7f9fd 0%, var(--bg) 100%); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .wrap { max-width: 1320px; margin: 24px auto; padding: 0 16px 44px; }
    .head { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: -0.01em; }
    .sub { margin-top: 6px; color: var(--muted); font-size: 14px; }
    .fab-actions { position: fixed; right: 16px; bottom: 16px; z-index: 50; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .fab-row { display: inline-flex; gap: 8px; }
    .fab-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 92px; padding: 8px 12px; border-radius: 999px; border: 1px solid #c8d6ef; background: #f5f9ff; color: #25406f; font-size: 12px; font-weight: 700; text-decoration: none; box-shadow: 0 4px 14px rgba(28, 52, 92, 0.14); }
    .fab-btn:hover { background: #eaf3ff; border-color: #b4c8e8; }
    .fab-tip { color: #5f7191; font-size: 11px; background: rgba(255, 255, 255, 0.92); border: 1px solid #d5e0f2; border-radius: 10px; padding: 6px 8px; }
    .cards { margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; box-shadow: 0 1px 4px rgba(16,24,40,0.04); }
    .card .k { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .v-list { display: grid; gap: 6px; }
    .kv { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 6px; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
    .name { color: #2c3a54; }
    .num { font-weight: 700; color: #0f1d38; }
    .legend { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; font-size: 12px; color: #334155; }
    .legend-dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }
    .insight-wrap { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .insight-item { background: #fff; border: 1px solid #dbe4f2; border-radius: 12px; padding: 10px 12px; }
    .insight-item.good { border-color: #bde7ce; background: #f3fcf7; }
    .insight-item.mid { border-color: #f2dfb5; background: #fffaf0; }
    .insight-item.bad { border-color: #f0c8c8; background: #fff6f6; }
    .insight-item.muted { border-color: #e2e8f0; background: #f8fafc; }
    .insight-title { font-size: 12px; font-weight: 800; color: #1f2a44; margin-bottom: 4px; }
    .insight-text { font-size: 12px; color: #495670; line-height: 1.4; }
    .trend-grid { margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .trend-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; box-shadow: 0 1px 4px rgba(16,24,40,0.04); }
    .trend-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
    .trend-head h3 { margin: 0; font-size: 14px; color: #334155; }
    .trend-sub { color: #7a8aa5; font-size: 11px; }
    .trend-card svg { width: 100%; height: auto; display: block; background: linear-gradient(180deg, #fbfdff 0%, #f7faff 100%); border: 1px solid #e6edf9; border-radius: 10px; }
    .chart-grid { stroke: #e8eef8; stroke-width: 1; }
    .axis-text { fill: #6f7f99; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .latest-row { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
    .latest-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #3c4a63; background: #f4f8ff; border: 1px solid #e3ebfb; border-radius: 999px; padding: 3px 8px; }
    .latest-item i { width: 7px; height: 7px; border-radius: 999px; display: inline-block; }
    .panels { margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .panel { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; box-shadow: 0 1px 4px rgba(16,24,40,0.04); }
    .panel h3 { margin: 0 0 10px; font-size: 14px; color: var(--muted); letter-spacing: 0.01em; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .axis-meta { font-size: 11px; color: #7386a7; }
    .bar-row { border-top: 1px solid #f0f3f8; padding: 8px 0 4px; }
    .bar-row:first-of-type { border-top: none; }
    .bar-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .bar-case { font-size: 12px; color: #334155; font-weight: 700; }
    .bar-meta { font-size: 11px; color: #6b7a96; background: #f3f7ff; border: 1px solid #e3eaf8; border-radius: 999px; padding: 2px 8px; }
    .v-chart { display: flex; align-items: flex-end; justify-content: center; gap: 7px; min-height: 190px; padding: 0 4px; }
    .v-col { flex: 0 0 auto; width: 78px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .v-value { font-size: 11px; color: #334155; text-align: center; font-weight: 700; background: #f3f7ff; border: 1px solid #e3eaf8; border-radius: 999px; padding: 2px 8px; }
    .v-track { width: 21px; height: 136px; background: repeating-linear-gradient(to top, #edf2f8 0, #edf2f8 1px, #f8fbff 1px, #f8fbff 20%); border-radius: 10px; display: flex; align-items: flex-end; overflow: hidden; border: 1px solid #e5ebf5; }
    .v-fill { width: 100%; border-radius: 8px 8px 0 0; }
    .v-label { font-size: 11px; font-weight: 700; text-align: center; }
    .v-delta { font-size: 10px; color: #64748b; min-height: 14px; }
    table { width: 100%; margin-top: 14px; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; box-shadow: 0 1px 4px rgba(16,24,40,0.04); }
    th, td { padding: 11px 10px; border-bottom: 1px solid var(--line); font-size: 12px; text-align: right; white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; }
    th:nth-child(2), td:nth-child(2) { text-align: left; }
    th:nth-child(3), td:nth-child(3) { text-align: left; }
    th { background: #f2f6fd; color: #44516a; font-weight: 700; }
    tbody tr:nth-child(even) td { background: #fbfdff; }
    tbody tr:hover td { background: #f6f9ff; }
    td.best { background: #ecfdf3 !important; color: #166534; font-weight: 700; }
    td.worst { background: #fff1f2 !important; color: #b42318; font-weight: 700; }
    .metric-chip { display: inline-block; background: #ecf3ff; color: #284c7a; border: 1px solid #d8e6ff; border-radius: 999px; padding: 2px 8px; font-weight: 700; font-size: 11px; }
    .reliability-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 58px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 800; border: 1px solid transparent; }
    .reliability-chip.good { background: #ebf9f0; color: #166534; border-color: #c8eed6; }
    .reliability-chip.mid { background: #fff8ea; color: #92400e; border-color: #f7e5b8; }
    .reliability-chip.bad { background: #fff1f2; color: #9f1239; border-color: #fecdd3; }
    .reliability-note { margin: -2px 0 10px; display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 5px 10px; font-size: 12px; border: 1px solid #d9e1ee; background: #f8fbff; color: #40516b; }
    .reliability-note.good { background: #f1f9f4; border-color: #cae9d5; color: #166534; }
    .reliability-note.mid { background: #fffaf0; border-color: #f2dfb5; color: #92400e; }
    .reliability-note.bad { background: #fff6f6; border-color: #f0c8c8; color: #9f1239; }
    .reliability-note.muted { background: #f8fafc; border-color: #e2e8f0; color: #475569; }
    .section-title { margin: 18px 0 8px; font-size: 14px; color: #334155; }
    .section-desc { margin: -2px 0 10px; color: #64748b; font-size: 12px; line-height: 1.45; }
    .table-wrap { overflow-x: auto; border-radius: 14px; }
    tr:last-child td { border-bottom: none; }
    .empty { font-size: 13px; color: var(--muted); padding: 12px 0; }
    @media print {
      body { background: #fff; }
      .wrap { max-width: none; margin: 0; padding: 0; }
      .fab-actions { display: none !important; }
      .head, .card, .trend-card, .panel, table { box-shadow: none; break-inside: avoid; }
      .section-title { margin-top: 12px; }
    }
    @media (max-width: 1024px) {
      .cards { grid-template-columns: 1fr 1fr; }
      .insight-wrap { grid-template-columns: 1fr; }
      .trend-grid { grid-template-columns: 1fr; }
      .panels { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      .wrap { padding: 0 10px 28px; }
      h1 { font-size: 22px; }
      .v-col { width: 66px; }
      .v-track { height: 112px; }
      table { min-width: 760px; }
      th, td { padding: 9px 8px; font-size: 11px; }
      .fab-actions { right: 10px; bottom: 10px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>성능 비교 대시보드</h1>
      <div class="sub">단말 ${escapeHtml(device)} 기준 앱 비교</div>
    </div>

    <div class="cards">
      ${renderCard('E2E 평균 (ms)', cards.e2e, c)}
      ${renderCard('Memory Delta 평균 (MB)', cards.mem, c)}
      ${renderCard('CPU 평균 (%)', cards.cpu, c)}
      ${renderCard('Current Avg (mA)', cards.current, c)}
    </div>
    <div class="legend">${legend}</div>
    <h2 class="section-title">한눈 해석</h2>
    ${insightHtml}

    <h2 class="section-title">반복 회차 추이</h2>
    <div class="section-desc">각 지표별로 대표 케이스 1개를 선택해 회차(1~N) 추이를 보여줍니다. 스냅샷 표와 역할이 다릅니다.</div>
    <div class="trend-grid">
      ${runTrendCard('e2eMs', runTrends.e2eMs, targetList, c)}
      ${runTrendCard('memoryDeltaMB', runTrends.memoryDeltaMB, targetList, c)}
      ${runTrendCard('cpuAvgPct', runTrends.cpuAvgPct, targetList, c)}
      ${runTrendCard('currentAvgmA', runTrends.currentAvgmA, targetList, c)}
    </div>

    <h2 class="section-title">케이스별 스냅샷 비교</h2>
    <div class="section-desc">같은 케이스에서 앱별 최신 값을 막대로 비교합니다. 값이 낮을수록 우수입니다.</div>
    <div class="panels">
      ${panel('e2eMs', rows, targetList, c, ranges)}
      ${panel('memoryDeltaMB', rows, targetList, c, ranges)}
      ${panel('cpuAvgPct', rows, targetList, c, ranges)}
      ${panel('currentAvgmA', rows, targetList, c, ranges)}
    </div>

    <h2 class="section-title">반복 실행 통계 (min / p5 / avg / p95 / max)</h2>
    <div class="section-desc">p5/p95는 극단값 영향을 줄인 분포 지표입니다. 반복횟수(n)가 많을수록 신뢰도가 높습니다.</div>
    <div class="reliability-note ${reliability.tone}">반복 신뢰도: <strong>${reliability.label}</strong> · ${reliability.detail}</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>번호</th>
            <th>케이스</th>
            <th>지표</th>
            <th>앱</th>
            <th>반복수</th>
            <th>min</th>
            <th>p5</th>
            <th>avg</th>
            <th>p95</th>
            <th>max</th>
            <th>변동폭</th>
            <th>중앙구간폭</th>
            <th>신뢰도</th>
          </tr>
        </thead>
        <tbody>${statRowsHtml || '<tr><td colspan="13">통계 데이터가 없습니다.</td></tr>'}</tbody>
      </table>
    </div>

    <h2 class="section-title">최신 스냅샷 비교</h2>
    <div class="section-desc">각 케이스의 최신 측정값을 표로 확인합니다. 보고서 공유/검토 시 원문 데이터 용도입니다.</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>번호</th>
            <th>케이스</th>
            <th>지표</th>
            ${targetCols}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>

    <div class="fab-actions" aria-label="다운로드">
      <div class="fab-row">
        <a class="fab-btn" href="./summary.csv" download>CSV</a>
        <a class="fab-btn" href="./summary_stats.csv" download>통계 CSV</a>
        <a class="fab-btn" href="./summary.pdf" download>PDF</a>
      </div>
      <div class="fab-tip">PDF가 없으면 테스트를 다시 실행해 최신 파일을 생성해 주세요.</div>
    </div>
  </div>
</body>
</html>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_HTML, html, 'utf8');
}

async function writeSummaryPdf() {
  type PdfOptions = {
    cwd: string;
    inputHtml: string;
    outputPdf: string;
  };
  type PdfModule = {
    generateSummaryPdf?: (options: PdfOptions) => Promise<void>;
    default?: {
      generateSummaryPdf?: (options: PdfOptions) => Promise<void>;
    };
  };

  const mod = require('../scripts/export-summary-pdf.js') as PdfModule;
  const generateSummaryPdf = mod.generateSummaryPdf ?? mod.default?.generateSummaryPdf;

  if (typeof generateSummaryPdf !== 'function') {
    throw new Error('generateSummaryPdf 함수를 찾지 못했습니다.');
  }

  await generateSummaryPdf({
    cwd: process.cwd(),
    inputHtml: SUMMARY_HTML,
    outputPdf: SUMMARY_PDF,
  });
}

export async function generateSummaryArtifacts(options: { force?: boolean } = {}) {
  const force = options.force === true || isTruthyEnv(process.env.PERF_SUMMARY_FORCE);
  const sourceStamp = buildMetricsSourceStamp();
  if (!sourceStamp) return;

  if (!force && hasRequiredSummaryOutputs()) {
    const prev = readSummaryMeta();
    if (prev?.sourceStamp === sourceStamp && prev?.generatorStamp === GENERATOR_STAMP) return;
  }

  const allMetrics = readMetrics();
  if (allMetrics.length === 0) return;

  const device = pickDevice(allMetrics);
  const metrics = allMetrics.filter((m) => m.device === device);
  const { cases, targets } = buildCases(metrics);
  const rows = makeRows(cases, targets);
  const statRows = buildStatRows(metrics, targets);

  let csvOk = false;
  let rawOk = false;
  let statsOk = false;
  let htmlOk = false;
  let pdfOk = false;

  try {
    writeSummaryCsv(device, rows, targets);
    csvOk = true;
  } catch (e) {
    console.warn('[summary] summary.csv 생성 실패:', (e as Error).message);
  }

  try {
    writeSummaryRawCsv(device, rows, targets);
    rawOk = true;
  } catch (e) {
    console.warn('[summary] summary_raw.csv 생성 실패:', (e as Error).message);
  }

  try {
    writeSummaryStatsCsv(device, statRows);
    statsOk = true;
  } catch (e) {
    console.warn('[summary] summary_stats.csv 생성 실패:', (e as Error).message);
  }

  // XLSX 생성은 현재 비활성화 상태입니다.

  try {
    writeSummaryHtml(device, rows, targets, statRows, metrics);
    htmlOk = true;
  } catch (e) {
    console.warn('[summary] summary.html 생성 실패:', (e as Error).message);
  }

  try {
    await writeSummaryPdf();
    pdfOk = true;
  } catch (e) {
    console.warn('[summary] summary.pdf 생성 실패:', (e as Error).message);
  }

  if (csvOk && rawOk && statsOk && htmlOk && pdfOk) {
    try {
      writeSummaryMeta({
        sourceStamp,
        generatorStamp: GENERATOR_STAMP,
        generatedAt: new Date().toISOString(),
        device,
      });
    } catch {}
  }
}
