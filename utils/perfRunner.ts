import { exec } from "node:child_process";
import { promisify } from "node:util";
import { AOS, IOS, type PerfPlatform } from "./appium";
import { flushMetrics, nowIso, writeMetric } from "./metric";
import { generateSummaryArtifacts } from "./summary";

type Sampler = () => Promise<number | null>;

type PerfSamplers = {
    memory?: Sampler;
    cpu?: Sampler;
    current?: Sampler;
};

type RunPerfOptions = {
    platform: PerfPlatform;
    deviceName: string; // 테스트 파일에서 지정 (예: iPhone 16 Pro)
    target: string; // 예: SK / KT / U+
    caseNo?: number | string; // 예: 1, 001
    caseName: string;
    sampleMs?: number;
    // 측정 전에 동일 시나리오를 사전 실행(메트릭 미기록)할 횟수
    warmupRuns?: number;
    // 샘플 최소치 미달 시 케이스 재시도 횟수
    sampleGateRetries?: number;
    // cpu/current sampler가 있을 때 필요한 최소 샘플 수
    minCpuSamples?: number;
    minCurrentSamples?: number;
    // true면 해당 케이스 종료 시 즉시 summary 생성 (기본값: false)
    writeSummary?: boolean;
    samplers: PerfSamplers;
    run: () => Promise<void>;
};

type RunPerfBatchOptions = {
    cases: RunPerfOptions[];
    continueOnError?: boolean;
    finalize?: boolean;
    forceSummary?: boolean;
    // true면 같은 case/target 조합의 첫 실행은 워밍업으로 소모
    warmupPerCase?: boolean;
};

const execAsync = promisify(exec);

async function sleepInterruptible(ms: number, signal: AbortSignal) {
    if (ms <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };

        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function toNumber(text: string): number | null {
    const m = text.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
}

async function execText(command: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync(command, {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        return stdout.trim();
    } catch {
        return null;
    }
}

async function safeSample(sampler?: Sampler): Promise<number | null> {
    if (!sampler) return null;
    try {
        return await sampler();
    } catch {
        return null;
    }
}

function pushMetric(
    category: "e2e" | "memory" | "cpu" | "current",
    platform: PerfPlatform,
    device: string,
    target: string,
    name: string,
    value: number,
    unit: string,
) {
    writeMetric({
        category,
        platform,
        device,
        target,
        name,
        value,
        unit,
        ts: nowIso(),
    });
}

function toCaseKey(
    caseNo: number | string | undefined,
    caseName: string,
): string {
    if (
        caseNo === undefined ||
        caseNo === null ||
        String(caseNo).trim() === ""
    ) {
        return caseName;
    }
    return `${String(caseNo).trim()}::${caseName}`;
}

function intOption(
    value: number | undefined,
    envName: string,
    fallback: number,
): number {
    if (value !== undefined && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
    }
    const env = Number(process.env[envName]);
    if (Number.isFinite(env)) {
        return Math.max(0, Math.floor(env));
    }
    return fallback;
}

function composeWarmupKey(options: RunPerfOptions): string {
    return [
        options.platform,
        options.deviceName,
        options.target,
        toCaseKey(options.caseNo, options.caseName),
    ].join("::");
}

export async function runPerfCase(options: RunPerfOptions) {
    const {
        platform,
        deviceName,
        target,
        caseNo,
        caseName,
        run,
        samplers,
        writeSummary = false,
    } = options;
    const sampleMs = options.sampleMs ?? 1500;
    const caseKey = toCaseKey(caseNo, caseName);
    const warmupRuns = intOption(options.warmupRuns, "PERF_WARMUP_RUNS", 0);
    const sampleGateRetries = intOption(
        options.sampleGateRetries,
        "PERF_SAMPLE_GATE_RETRIES",
        1,
    );
    const minCpuSamples = intOption(
        options.minCpuSamples,
        "PERF_MIN_CPU_SAMPLES",
        2,
    );
    const minCurrentSamples = intOption(
        options.minCurrentSamples,
        "PERF_MIN_CURRENT_SAMPLES",
        2,
    );

    const runMeasuredOnce = async () => {
        const memoryBefore = await safeSample(samplers.memory);

        const cpuSamples: number[] = [];
        const currentSamples: number[] = [];
        const samplingAbort = new AbortController();
        const samplingLoop = (async () => {
            // Use fixed target ticks so sampler runtime does not permanently shift the cadence.
            let nextTick = Date.now();
            while (!samplingAbort.signal.aborted) {
                const [cpu, current] = await Promise.all([
                    safeSample(samplers.cpu),
                    safeSample(samplers.current),
                ]);
                if (cpu !== null) cpuSamples.push(cpu);
                if (current !== null) currentSamples.push(current);

                if (samplingAbort.signal.aborted) break;
                nextTick += sampleMs;
                const wait = Math.max(0, nextTick - Date.now());
                await sleepInterruptible(wait, samplingAbort.signal);
            }
        })();

        const startedAt = Date.now();
        let runError: unknown = null;
        try {
            await run();
        } catch (e) {
            runError = e;
        }
        const e2eMs = Date.now() - startedAt;

        samplingAbort.abort();
        await samplingLoop;

        const memoryAfter = await safeSample(samplers.memory);
        return {
            runError,
            e2eMs,
            memoryBefore,
            memoryAfter,
            cpuSamples,
            currentSamples,
        };
    };

    for (let i = 0; i < warmupRuns; i += 1) {
        const warmup = await runMeasuredOnce();
        if (warmup.runError) throw warmup.runError;
    }

    const needCpuGate = !!samplers.cpu;
    const needCurrentGate = !!samplers.current;
    let accepted: {
        e2eMs: number;
        memoryBefore: number | null;
        memoryAfter: number | null;
        cpuSamples: number[];
        currentSamples: number[];
    } | null = null;
    let lastGateMessage = "";

    for (let attempt = 0; attempt <= sampleGateRetries; attempt += 1) {
        const measured = await runMeasuredOnce();
        if (measured.runError) throw measured.runError;

        const cpuOk =
            !needCpuGate || measured.cpuSamples.length >= minCpuSamples;
        const currentOk =
            !needCurrentGate ||
            measured.currentSamples.length >= minCurrentSamples;

        if (cpuOk && currentOk) {
            accepted = measured;
            break;
        }

        const cpuMsg = needCpuGate
            ? `cpu ${measured.cpuSamples.length}/${minCpuSamples}`
            : "cpu n/a";
        const currentMsg = needCurrentGate
            ? `current ${measured.currentSamples.length}/${minCurrentSamples}`
            : "current n/a";
        lastGateMessage = `${cpuMsg}, ${currentMsg}`;
    }

    if (!accepted) {
        throw new Error(
            `sample gate failed for "${caseKey}" after ${sampleGateRetries + 1} attempts (${lastGateMessage})`,
        );
    }

    pushMetric(
        "e2e",
        platform,
        deviceName,
        target,
        `${caseKey}.duration`,
        accepted.e2eMs,
        "ms",
    );

    if (accepted.memoryAfter !== null) {
        pushMetric(
            "memory",
            platform,
            deviceName,
            target,
            `${caseKey}.after`,
            accepted.memoryAfter,
            "MB",
        );
    }
    if (accepted.memoryBefore !== null && accepted.memoryAfter !== null) {
        pushMetric(
            "memory",
            platform,
            deviceName,
            target,
            `${caseKey}.delta`,
            accepted.memoryAfter - accepted.memoryBefore,
            "MB",
        );
    }

    if (accepted.cpuSamples.length > 0) {
        const avg =
            accepted.cpuSamples.reduce((a, b) => a + b, 0) /
            accepted.cpuSamples.length;
        pushMetric(
            "cpu",
            platform,
            deviceName,
            target,
            `${caseKey}.avg`,
            Number(avg.toFixed(2)),
            "%",
        );
    }
    if (accepted.currentSamples.length > 0) {
        const avg =
            accepted.currentSamples.reduce((a, b) => a + b, 0) /
            accepted.currentSamples.length;
        pushMetric(
            "current",
            platform,
            deviceName,
            target,
            `${caseKey}.avg`,
            Number(avg.toFixed(2)),
            "mA",
        );
    }

    flushMetrics();

    if (writeSummary) {
        try {
            await generateSummaryArtifacts();
        } catch {}
    }
}

// 배치(반복 실행) 마지막에 1회만 호출해서 summary 산출물 생성
export async function finalizePerfBatch() {
    flushMetrics();
    await generateSummaryArtifacts();
}

// 반복 케이스 실행 + summary 종료 처리를 한 번에 보장하는 배치 유틸
export async function runPerfBatch(options: RunPerfBatchOptions) {
    const {
        cases,
        continueOnError = false,
        finalize = true,
        forceSummary = false,
        warmupPerCase = true,
    } = options;

    let firstError: unknown = null;
    const warmed = new Set<string>();

    for (const c of cases) {
        try {
            const warmupKey = composeWarmupKey(c);
            const shouldWarmup = warmupPerCase && !warmed.has(warmupKey);
            if (shouldWarmup) warmed.add(warmupKey);

            await runPerfCase({
                ...c,
                warmupRuns: c.warmupRuns ?? (shouldWarmup ? 1 : 0),
                writeSummary: false,
            });
        } catch (e) {
            if (!firstError) firstError = e;
            if (!continueOnError) break;
        }
    }

    if (finalize) {
        try {
            flushMetrics();
            await generateSummaryArtifacts({ force: forceSummary });
        } catch (e) {
            if (!firstError) firstError = e;
        }
    }

    if (firstError) throw firstError;
}

async function execNumber(command: string): Promise<number | null> {
    const out = await execText(command);
    return out === null ? null : toNumber(out);
}

function normalizeCurrentToMilliAmp(raw: number): number {
    const abs = Math.abs(raw);
    // Device마다 current_now 단위가 다를 수 있어 큰 값은 uA로 보고 mA로 변환.
    if (abs >= 10000) return Number((abs / 1000).toFixed(2));
    if (abs > 5000) return Number((abs / 1000).toFixed(2));
    return Number(abs.toFixed(2));
}

export function createAosSamplers(): PerfSamplers {
    const udid = AOS.udid;
    const pkg = AOS.appPackage;

    const memory: Sampler = async () => {
        const out = await execText(
            `adb -s ${udid} shell dumpsys meminfo ${pkg}`,
        );
        if (out === null) return null;
        const pssKb =
            toNumber(out.match(/TOTAL\s+PSS:\s+(\d+)/)?.[1] ?? "") ??
            toNumber(out.match(/\bTOTAL\b\s+(\d+)\s+/m)?.[1] ?? "");
        return pssKb === null ? null : Number((pssKb / 1024).toFixed(2));
    };

    const cpu: Sampler = async () => {
        const out = await execText(
            `adb -s ${udid} shell dumpsys cpuinfo ${pkg}`,
        );
        if (out === null) return null;
        const percent = toNumber(out.match(/([\d.]+)%/m)?.[1] ?? "");
        return percent === null ? null : Number(percent.toFixed(2));
    };

    const current: Sampler = async () => {
        const out = await execText(
            `adb -s ${udid} shell "cat /sys/class/power_supply/battery/current_now 2>/dev/null || cat /sys/class/power_supply/battery/BatteryAverageCurrent 2>/dev/null || echo ''"`,
        );
        if (out === null) return null;
        const n = toNumber(out);
        return n === null ? null : normalizeCurrentToMilliAmp(n);
    };

    return { memory, cpu, current };
}

export function createIosSamplers(): PerfSamplers {
    const memoryCmd = process.env.IOS_MEMORY_CMD;
    const cpuCmd = process.env.IOS_CPU_CMD;
    const currentCmd = process.env.IOS_CURRENT_CMD;
    const samplers: PerfSamplers = {};

    if (memoryCmd) {
        samplers.memory = async () => execNumber(memoryCmd);
    }
    if (cpuCmd) {
        samplers.cpu = async () => execNumber(cpuCmd);
    }
    if (currentCmd) {
        samplers.current = async () => {
            const n = await execNumber(currentCmd);
            return n === null ? null : normalizeCurrentToMilliAmp(n);
        };
    }

    return samplers;
}

export function currentPlatform(): PerfPlatform {
    const p = (process.env.PERF_PLATFORM ?? "ios").toLowerCase();
    return p === "aos" ? "aos" : "ios";
}

export function defaultSamplers(platform: PerfPlatform): PerfSamplers {
    return platform === "aos" ? createAosSamplers() : createIosSamplers();
}

export function targetAppId(platform: PerfPlatform): string {
    return platform === "aos" ? AOS.appPackage : IOS.bundleId;
}
