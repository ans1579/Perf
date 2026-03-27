import fs from "node:fs";
import path from "node:path";

export type PerfMetric = {
    category: "e2e" | "memory" | "cpu" | "power" | "current";
    platform: "ios" | "aos";
    device: string;
    target: string;
    name: string;
    value: number;
    unit: string;
    ts: string;
};

const OUT_DIR = path.join(process.cwd(), "test-output", "perf-metrics");
const JSONL_PATH = path.join(OUT_DIR, "metrics.jsonl");
const CSV_PATH = path.join(OUT_DIR, "metrics.csv");
const CSV_HEADER = "category,platform,device,target,name,value,unit,ts\n";

// 기본은 ON, 필요 시 PERF_WRITE_METRICS_CSV=0 으로 끌 수 있음
const METRICS_CSV_ENABLED = !/^(0|false|no|off)$/i.test(
    (process.env.PERF_WRITE_METRICS_CSV ?? "1").trim(),
);

// 기본은 ON, 필요 시 PERF_BUFFER_METRICS=0 으로 끌 수 있음
const METRICS_BUFFERED = !/^(0|false|no|off)$/i.test(
    (process.env.PERF_BUFFER_METRICS ?? "1").trim(),
);

let isPrepared = false;
let flushHookInstalled = false;
const pendingJsonl: string[] = [];
const pendingCsv: string[] = [];

function escapeCsv(value: string) {
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

function ensureOut() {
    if (isPrepared) return;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    if (METRICS_CSV_ENABLED && !fs.existsSync(CSV_PATH)) {
        fs.writeFileSync(CSV_PATH, CSV_HEADER, "utf8");
    }
    isPrepared = true;
}

function ensureFlushHook() {
    if (flushHookInstalled) return;
    flushHookInstalled = true;

    const safeFlush = () => {
        try {
            flushMetrics();
        } catch {}
    };

    process.once("beforeExit", safeFlush);
    process.once("exit", safeFlush);
}

export function flushMetrics() {
    ensureOut();

    if (pendingJsonl.length > 0) {
        fs.appendFileSync(JSONL_PATH, pendingJsonl.join(""), "utf8");
        pendingJsonl.length = 0;
    }

    if (METRICS_CSV_ENABLED && pendingCsv.length > 0) {
        fs.appendFileSync(CSV_PATH, pendingCsv.join(""), "utf8");
        pendingCsv.length = 0;
    }
}

export function writeMetric(metric: PerfMetric) {
    ensureOut();

    const jsonLine = `${JSON.stringify(metric)}\n`;
    const csvLine = METRICS_CSV_ENABLED
        ? `${[
              metric.category,
              metric.platform,
              metric.device,
              metric.target,
              metric.name,
              String(metric.value),
              metric.unit,
              metric.ts,
          ]
              .map(escapeCsv)
              .join(",")}\n`
        : null;

    if (!METRICS_BUFFERED) {
        fs.appendFileSync(JSONL_PATH, jsonLine, "utf8");
        if (csvLine !== null) fs.appendFileSync(CSV_PATH, csvLine, "utf8");
        return;
    }

    ensureFlushHook();
    pendingJsonl.push(jsonLine);
    if (csvLine !== null) pendingCsv.push(csvLine);

    // 너무 오래 메모리에 쌓지 않도록 라인 수 기준으로 중간 flush
    if (pendingJsonl.length >= 25) flushMetrics();
}

export function nowIso() {
    return new Date().toISOString();
}
