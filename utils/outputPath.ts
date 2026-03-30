import fs from "node:fs";
import path from "node:path";

function resolveProjectRoot(): string {
    const envRoot = (process.env.PERF_PROJECT_ROOT ?? "").trim();
    if (envRoot) return path.resolve(envRoot);

    let dir = path.resolve(__dirname, "..");
    while (true) {
        const pkgPath = path.join(dir, "package.json");
        if (fs.existsSync(pkgPath)) {
            try {
                const parsed = JSON.parse(
                    fs.readFileSync(pkgPath, "utf8"),
                ) as { name?: string };
                if ((parsed?.name ?? "").trim() === "perf") return dir;
            } catch {}
        }

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return path.resolve(__dirname, "..");
}

const PROJECT_ROOT = resolveProjectRoot();
const ROOT_DIR = path.join(PROJECT_ROOT, "test-output", "perf-metrics");
const LATEST_META_PATH = path.join(ROOT_DIR, "latest-run.json");
const LATEST_DIR = path.join(ROOT_DIR, "latest");

let cachedRunId: string | null = null;
let cachedOutDir: string | null = null;

function pad(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

function sanitizeRunId(raw: string): string {
    const cleaned = raw.trim().replace(/[^\p{L}\p{N}._-]/gu, "-");
    return cleaned.replace(/^-+|-+$/g, "");
}

function buildAutoRunIdBase(date: Date): string {
    const stamp =
        `${date.getFullYear()}` +
        `${pad(date.getMonth() + 1)}` +
        `${pad(date.getDate())}-` +
        `${pad(date.getHours())}` +
        `${pad(date.getMinutes())}`;

    const rawLabel = process.env.PERF_RUN_LABEL ?? "";
    const rawDevice = process.env.PERF_RUN_DEVICE ?? "";
    const label = sanitizeRunId(rawLabel).slice(0, 48);
    const device = sanitizeRunId(rawDevice).slice(0, 32);

    const parts = [stamp];
    if (label) parts.push(label);
    if (device) parts.push(device);
    return parts.join("-");
}

function ensureUniqueRunId(base: string): string {
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    let candidate = base;
    let seq = 2;

    while (fs.existsSync(path.join(ROOT_DIR, candidate))) {
        candidate = `${base}-r${seq}`;
        seq += 1;
    }

    return candidate;
}

export function getPerfRootDir(): string {
    return ROOT_DIR;
}

export function getPerfRunId(): string {
    if (cachedRunId) return cachedRunId;

    const envRunId = process.env.PERF_RUN_ID ?? process.env.PERF_CAMPAIGN_ID;
    if (envRunId) {
        const sanitized = sanitizeRunId(envRunId);
        if (sanitized) {
            cachedRunId = sanitized;
            return cachedRunId;
        }
    }

    cachedRunId = ensureUniqueRunId(buildAutoRunIdBase(new Date()));
    return cachedRunId;
}

export function getPerfOutDir(): string {
    if (cachedOutDir) return cachedOutDir;

    const outDir = path.join(ROOT_DIR, getPerfRunId());
    cachedOutDir = outDir;
    return cachedOutDir;
}

export function ensurePerfOutDir(): string {
    const outDir = getPerfOutDir();
    fs.mkdirSync(outDir, { recursive: true });
    return outDir;
}

export function markPerfRunAsLatest(): void {
    const outDir = ensurePerfOutDir();
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.writeFileSync(
        LATEST_META_PATH,
        JSON.stringify(
            {
                runId: getPerfRunId(),
                outDir,
                updatedAt: new Date().toISOString(),
            },
            null,
            2,
        ) + "\n",
        "utf8",
    );
}

export function syncLatestArtifactsToRoot(): void {
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.mkdirSync(LATEST_DIR, { recursive: true });

    const latestPath = LATEST_META_PATH;
    const legacyLatestPath = path.join(ROOT_DIR, "latest.json");
    let outDir: string | null = null;

    if (cachedOutDir && fs.existsSync(cachedOutDir)) {
        outDir = cachedOutDir;
    } else if (fs.existsSync(latestPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(latestPath, "utf8")) as {
                outDir?: string;
            };
            if (parsed?.outDir && fs.existsSync(parsed.outDir)) {
                outDir = parsed.outDir;
            }
        } catch {}
    } else if (fs.existsSync(legacyLatestPath)) {
        try {
            const parsed = JSON.parse(
                fs.readFileSync(legacyLatestPath, "utf8"),
            ) as { outDir?: string };
            if (parsed?.outDir && fs.existsSync(parsed.outDir)) {
                outDir = parsed.outDir;
            }
        } catch {}
    }

    if (!outDir) return;

    const files = [
        "metrics.jsonl",
        "metrics.csv",
        "summary.csv",
        "summary_raw.csv",
        "summary_stats.csv",
        "summary.html",
        "summary.pdf",
        "summary.meta.json",
    ];

    for (const name of files) {
        const src = path.join(outDir, name);
        if (!fs.existsSync(src)) continue;
        const latestDst = path.join(LATEST_DIR, name);
        fs.copyFileSync(src, latestDst);
    }
}
