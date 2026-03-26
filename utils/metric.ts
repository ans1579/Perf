import fs from 'node:fs';
import path from 'node:path';

export type PerfMetric = {
  category: 'e2e' | 'memory' | 'cpu' | 'power' | 'current';
  platform: 'ios' | 'aos';
  device: string;
  target: string;
  name: string;
  value: number;
  unit: string;
  ts: string;
};

const OUT_DIR = path.join(process.cwd(), 'test-output', 'perf-metrics');
const JSONL_PATH = path.join(OUT_DIR, 'metrics.jsonl');
const CSV_PATH = path.join(OUT_DIR, 'metrics.csv');

function ensureOut() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, 'category,platform,device,target,name,value,unit,ts\n', 'utf8');
  }
}

export function writeMetric(metric: PerfMetric) {
  ensureOut();
  fs.appendFileSync(JSONL_PATH, `${JSON.stringify(metric)}\n`, 'utf8');
  fs.appendFileSync(
    CSV_PATH,
    `${metric.category},${metric.platform},${metric.device},${metric.target},${metric.name},${metric.value},${metric.unit},${metric.ts}\n`,
    'utf8'
  );
}

export function nowIso() {
  return new Date().toISOString();
}
