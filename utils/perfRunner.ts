import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { AOS, IOS, type PerfPlatform } from "./appium";
import { flushMetrics, nowIso, writeMetric } from "./metric";
import { generateSummaryArtifacts } from "./summary";

// -----------------------------------------------------------------------------
// 공통 타입 / 옵션
// -----------------------------------------------------------------------------
type Sampler = () => Promise<number | null>;

type PerfSamplers = {
    memory?: Sampler;
    cpu?: Sampler;
    current?: Sampler;
    resetState?: () => void;
    startSampling?: () => Promise<void> | void;
    stopSampling?: () => Promise<void> | void;
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
    // true면 해당 케이스 종료 시 즉시 summary 생성 (기본값: true)
    writeSummary?: boolean;
    // 측정 시작 전에 실행되는 준비 동작(측정 구간 제외)
    beforeRun?: () => Promise<void>;
    // 측정 종료 후 실행되는 정리 동작(측정 구간 제외)
    afterRun?: () => Promise<void>;
    // 공통 sampler 위에 케이스별 커스텀 sampler를 덮어쓸 때 사용
    samplers?: PerfSamplers;
    // AOS 공통 sampler 생성 시 사용할 앱 패키지/UDID (케이스별 앱 측정용)
    samplerAppPackage?: string;
    samplerUdid?: string;
    samplerProcessHints?: string[];
    // no process found 시 memory를 0으로 볼지 여부 (기본 true)
    noProcessMemoryAsZero?: boolean;
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

type AosSamplerOptions = {
    udid?: string;
    appPackage?: string;
    noProcessMemoryAsZero?: boolean;
};
type IosSamplerOptions = {
    udid?: string;
    bundleId?: string;
    deviceRef?: string;
    processHints?: string[];
};

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// -----------------------------------------------------------------------------
// 공통 유틸
// -----------------------------------------------------------------------------
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

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function safeSampleWithRetry(sampler: Sampler | undefined, retries: number, waitMs: number): Promise<number | null> {
    let last: number | null = null;
    for (let i = 0; i <= retries; i += 1) {
        last = await safeSample(sampler);
        if (last !== null) return last;
        if (i < retries && waitMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
    }
    return last;
}

function pushMetric(category: "e2e" | "memory" | "cpu" | "current", platform: PerfPlatform, device: string, target: string, name: string, value: number, unit: string) {
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

function toCaseKey(caseNo: number | string | undefined, caseName: string): string {
    if (caseNo === undefined || caseNo === null || String(caseNo).trim() === "") {
        return caseName;
    }
    return `${String(caseNo).trim()}::${caseName}`;
}

function intOption(value: number | undefined, envName: string, fallback: number): number {
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
    return [options.platform, options.deviceName, options.target, toCaseKey(options.caseNo, options.caseName)].join("::");
}

function mergeSamplers(base: PerfSamplers, override?: PerfSamplers): PerfSamplers {
    return {
        memory: override?.memory ?? base.memory,
        cpu: override?.cpu ?? base.cpu,
        current: override?.current ?? base.current,
        resetState: override?.resetState ?? base.resetState,
        startSampling: override?.startSampling ?? base.startSampling,
        stopSampling: override?.stopSampling ?? base.stopSampling,
    };
}

function resolveSamplers(options: RunPerfOptions): PerfSamplers {
    if (options.platform === "aos") {
        const base = createAosSamplers({
            udid: options.samplerUdid,
            appPackage: options.samplerAppPackage,
            noProcessMemoryAsZero: options.noProcessMemoryAsZero,
        });
        return mergeSamplers(base, options.samplers);
    }

    const base = createIosSamplers({
        udid: options.samplerUdid,
        bundleId: options.samplerAppPackage ?? process.env.IOS_SAMPLER_BUNDLE_ID ?? IOS.bundleId,
        processHints: options.samplerProcessHints,
    });
    return mergeSamplers(base, options.samplers);
}

// -----------------------------------------------------------------------------
// 공통 실행 엔진 (runPerfCase / runPerfBatch)
// -----------------------------------------------------------------------------
export async function runPerfCase(options: RunPerfOptions) {
    const { platform, deviceName, target, caseNo, caseName, run, beforeRun, afterRun, writeSummary = true } = options;
    const samplers = resolveSamplers(options);
    const sampleMs = options.sampleMs ?? 1500;
    const caseKey = toCaseKey(caseNo, caseName);
    const warmupRuns = intOption(options.warmupRuns, "PERF_WARMUP_RUNS", 0);
    const sampleGateRetries = intOption(options.sampleGateRetries, "PERF_SAMPLE_GATE_RETRIES", 1);
    const minCpuSamples = intOption(options.minCpuSamples, "PERF_MIN_CPU_SAMPLES", 2);
    const minCurrentSamples = intOption(options.minCurrentSamples, "PERF_MIN_CURRENT_SAMPLES", 4);
    const strictSampleGate = /^(1|true|yes|y|on)$/i.test(String(process.env.PERF_SAMPLE_GATE_STRICT ?? "").trim());

    const runMeasuredOnce = async () => {
        if (beforeRun) await beforeRun();

        const memoryBefore = await safeSample(samplers.memory);
        // xctrace CPU 샘플러는 첫 호출을 델타 기준점으로 삼으므로 측정 직전 1회 프라이밍한다.
        await safeSample(samplers.cpu);

        const memorySamples: number[] = [];
        const cpuSamples: number[] = [];
        const currentSamples: number[] = [];
        const samplingAbort = new AbortController();
        const samplingLoop = (async () => {
            // Use fixed target ticks so sampler runtime does not permanently shift the cadence.
            let nextTick = Date.now();
            while (!samplingAbort.signal.aborted) {
                const [memory, cpu, current] = await Promise.all([safeSample(samplers.memory), safeSample(samplers.cpu), safeSample(samplers.current)]);
                if (memory !== null) memorySamples.push(memory);
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

        // run 성공 시에만 tail 샘플을 보강 채집한다.
        if (!runError) {
            let needTailMemory = !!samplers.memory && memorySamples.length === 0;
            let needTailCpu = !!samplers.cpu && cpuSamples.length === 0;
            let needTailCurrent = !!samplers.current && currentSamples.length === 0;

            for (let i = 0; i < 3 && (needTailMemory || needTailCpu || needTailCurrent); i += 1) {
                const [tailMemory, tailCpu, tailCurrent] = await Promise.all([
                    needTailMemory ? safeSample(samplers.memory) : Promise.resolve(null),
                    needTailCpu ? safeSample(samplers.cpu) : Promise.resolve(null),
                    needTailCurrent ? safeSample(samplers.current) : Promise.resolve(null),
                ]);
                if (tailMemory !== null) {
                    memorySamples.push(tailMemory);
                    needTailMemory = false;
                }
                if (tailCpu !== null) {
                    cpuSamples.push(tailCpu);
                    needTailCpu = false;
                }
                if (tailCurrent !== null) {
                    currentSamples.push(tailCurrent);
                    needTailCurrent = false;
                }
                if (needTailMemory || needTailCpu || needTailCurrent) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 200));
                }
            }
        }

        samplingAbort.abort();
        await samplingLoop;

        const memoryAfter = runError ? await safeSample(samplers.memory) : await safeSampleWithRetry(samplers.memory, 2, 200);
        if (memoryAfter !== null) memorySamples.push(memoryAfter);

        if (afterRun) {
            try {
                await afterRun();
            } catch (e) {
                if (!runError) runError = e;
            }
        }

        return {
            runError,
            e2eMs,
            memoryBefore,
            memoryAfter,
            memorySamples,
            cpuSamples,
            currentSamples,
        };
    };

    await samplers.startSampling?.();
    try {
        for (let i = 0; i < warmupRuns; i += 1) {
            const warmup = await runMeasuredOnce();
            if (warmup.runError) throw warmup.runError;
        }

        // 워밍업 상태가 본 측정에 영향을 주지 않도록 샘플러 내부 상태를 초기화한다.
        samplers.resetState?.();

        const needCpuGate = !!samplers.cpu;
        const needCurrentGate = !!samplers.current && platform !== "ios";
        let accepted: {
            e2eMs: number;
            memoryBefore: number | null;
            memoryAfter: number | null;
            memorySamples: number[];
            cpuSamples: number[];
            currentSamples: number[];
        } | null = null;
        let lastMeasured: {
            e2eMs: number;
            memoryBefore: number | null;
            memoryAfter: number | null;
            memorySamples: number[];
            cpuSamples: number[];
            currentSamples: number[];
        } | null = null;
        let lastGateMessage = "";

        for (let attempt = 0; attempt <= sampleGateRetries; attempt += 1) {
            // 재시도 간에도 상태 누적 영향을 제거한다.
            samplers.resetState?.();
            const measured = await runMeasuredOnce();
            if (measured.runError) throw measured.runError;
            lastMeasured = measured;

            // 0%도 유효 샘플로 인정한다.
            const cpuValidCount = measured.cpuSamples.filter((v) => Number.isFinite(v) && v >= 0).length;
            const cpuOk = !needCpuGate || cpuValidCount >= minCpuSamples;
            const currentOk = !needCurrentGate || measured.currentSamples.length >= minCurrentSamples;

            if (cpuOk && currentOk) {
                accepted = measured;
                break;
            }

            const cpuMsg = needCpuGate ? `cpu ${cpuValidCount}/${minCpuSamples} (raw=${measured.cpuSamples.length})` : "cpu n/a";
            const currentMsg = needCurrentGate ? `current ${measured.currentSamples.length}/${minCurrentSamples}` : "current n/a";
            lastGateMessage = `${cpuMsg}, ${currentMsg}`;
        }

        if (!accepted) {
            if (strictSampleGate || !lastMeasured) {
                throw new Error(`sample gate failed for "${caseKey}" after ${sampleGateRetries + 1} attempts (${lastGateMessage})`);
            }
            accepted = lastMeasured;
            console.warn(`[perf] sample gate relaxed for "${caseKey}" (${lastGateMessage})`);
        }

        // 케이스 재실행 없이 마지막 보강 샘플을 채집한다.
        if (samplers.cpu && accepted.cpuSamples.filter((v) => Number.isFinite(v) && v >= 0).length === 0) {
            const fallbackCpu = await safeSampleWithRetry(samplers.cpu, 2, 250);
            if (fallbackCpu !== null) accepted.cpuSamples.push(fallbackCpu);
        }
        if (samplers.memory && accepted.memoryAfter === null) {
            const fallbackMemory = await safeSampleWithRetry(samplers.memory, 2, 250);
            if (fallbackMemory !== null) {
                accepted.memoryAfter = fallbackMemory;
                accepted.memorySamples.push(fallbackMemory);
            }
        }

        pushMetric("e2e", platform, deviceName, target, `${caseKey}.duration`, accepted.e2eMs, "ms");

        const memoryAfterForMetric = accepted.memoryAfter ?? (accepted.memorySamples.length > 0 ? accepted.memorySamples[accepted.memorySamples.length - 1] : null);
        if (memoryAfterForMetric !== null) {
            pushMetric("memory", platform, deviceName, target, `${caseKey}.after`, memoryAfterForMetric, "MB");
        }
        const memoryPeak = accepted.memorySamples.length > 0 ? Math.max(...accepted.memorySamples) : memoryAfterForMetric;
        if (memoryPeak !== null && Number.isFinite(memoryPeak)) {
            pushMetric("memory", platform, deviceName, target, `${caseKey}.peak`, Number(memoryPeak.toFixed(2)), "MB");
        }
        const memoryBaseline = accepted.memoryBefore ?? 0;
        if (memoryPeak !== null && Number.isFinite(memoryPeak)) {
            const memoryDelta = Math.max(0, Number((memoryPeak - memoryBaseline).toFixed(2)));
            pushMetric("memory", platform, deviceName, target, `${caseKey}.delta`, memoryDelta, "MB");
        }

        const cpuForAvg = accepted.cpuSamples.filter((v) => Number.isFinite(v) && v >= 0);
        if (cpuForAvg.length > 0) {
            const avg = cpuForAvg.reduce((a, b) => a + b, 0) / cpuForAvg.length;
            pushMetric("cpu", platform, deviceName, target, `${caseKey}.avg`, Number(avg.toFixed(2)), "%");
        }
        if (accepted.currentSamples.length > 0) {
            const avg = accepted.currentSamples.reduce((a, b) => a + b, 0) / accepted.currentSamples.length;
            pushMetric("current", platform, deviceName, target, `${caseKey}.avg`, Number(avg.toFixed(2)), "mA");
        }

        flushMetrics();

        if (writeSummary) {
            try {
                await generateSummaryArtifacts();
            } catch (e) {
                console.warn(`[perf] summary generation failed in runPerfCase: ${String((e as Error)?.message ?? e)}`);
            }
        }
    } finally {
        await samplers.stopSampling?.();
    }
}

// 배치(반복 실행) 마지막에 1회만 호출해서 summary 산출물 생성
export async function finalizePerfBatch() {
    flushMetrics();
    await generateSummaryArtifacts();
}

// 반복 케이스 실행 + summary 종료 처리를 한 번에 보장하는 배치 유틸
export async function runPerfBatch(options: RunPerfBatchOptions) {
    const { cases, continueOnError = false, finalize = true, forceSummary = false, warmupPerCase = true } = options;

    let firstError: unknown = null;
    const warmed = new Set<string>();

    for (const c of cases) {
        try {
            const warmupKey = composeWarmupKey(c);
            const shouldWarmup = warmupPerCase && !warmed.has(warmupKey);
            if (shouldWarmup) warmed.add(warmupKey);

            await runPerfCase({
                ...c,
                warmupRuns: c.warmupRuns !== undefined ? c.warmupRuns : shouldWarmup ? 1 : 0,
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
            console.warn(`[perf] summary generation failed in runPerfBatch: ${String((e as Error)?.message ?? e)}`);
            if (!firstError) firstError = e;
        }
    }

    if (firstError) throw firstError;
}

async function execNumber(command: string): Promise<number | null> {
    const out = await execText(command);
    return out === null ? null : toNumber(out);
}

function normalizeCurrentToMilliAmpSigned(raw: number): number {
    const sign = raw < 0 ? -1 : 1;
    const abs = Math.abs(raw);
    // Device마다 current 계열 단위가 다를 수 있어 큰 값은 uA로 보고 mA로 변환.
    const milliAmp = abs >= 5000 ? abs / 1000 : abs;
    return Number((milliAmp * sign).toFixed(2));
}

// -----------------------------------------------------------------------------
// AOS 샘플러
// -----------------------------------------------------------------------------
export function createAosSamplers(options: AosSamplerOptions = {}): PerfSamplers {
    const udid = options.udid ?? AOS.udid;
    const pkg = options.appPackage ?? AOS.appPackage;
    const noProcessMemoryAsZero = options.noProcessMemoryAsZero ?? true;
    // 기본값: 앱 코어합 CPU를 단말 전체 기준(0~100%)으로 정규화
    const normalizeCpuByCores = !/^(0|false|no|off)$/i.test(String(process.env.PERF_CPU_NORMALIZE_BY_CORES ?? "1").trim());
    const allowChargingCurrent = !/^(0|false|no|off)$/i.test(String(process.env.PERF_CURRENT_MEASURE_WHILE_CHARGING ?? "1").trim());
    let cachedCharging = false;
    let cachedChargingCheckedAt = 0;
    let cachedCpuCores: number | null = null;
    let lastProcCpu: {
        pid: number;
        procTicks: number;
        totalTicks: number;
    } | null = null;

    const isCharging = async (): Promise<boolean> => {
        const now = Date.now();
        if (now - cachedChargingCheckedAt < 5000) return cachedCharging;

        const out = await execText(`adb -s ${udid} shell dumpsys battery`);
        if (out !== null) {
            const status = toNumber(out.match(/status:\s*(\d+)/)?.[1] ?? "");
            if (status !== null) {
                // Android status: 2=charging, 5=full(plugged)
                cachedCharging = status === 2 || status === 5;
            }
        }
        cachedChargingCheckedAt = now;
        return cachedCharging;
    };

    const getCpuCores = async (): Promise<number> => {
        if (cachedCpuCores !== null) return cachedCpuCores;
        const out = await execText(`adb -s ${udid} shell "nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1"`);
        const cores = out === null ? null : toNumber(out);
        const asInt = cores === null ? 1 : Math.max(1, Math.trunc(cores));
        cachedCpuCores = asInt;
        return asInt;
    };

    const normalizeCpu = async (raw: number): Promise<number> => {
        if (!normalizeCpuByCores) return Number(raw.toFixed(2));
        const cores = await getCpuCores();
        // top 기준 앱 코어합(%core)을 단말 전체 기준(%)으로 변환
        const normalized = raw / cores;
        return Number(Math.max(0, Math.min(100, normalized)).toFixed(2));
    };

    const parseProcCpuSnapshot = async (): Promise<
        | {
              pid: number;
              procTicks: number;
              totalTicks: number;
          }
        | "NOPROC"
        | null
    > => {
        const out = await execText(
            `adb -s ${udid} shell "pid=\\$(pidof ${pkg} 2>/dev/null | awk '{print \\$1}'); if [ -z \\\"\\$pid\\\" ]; then echo NOPROC; exit 0; fi; echo PID=\\$pid; cat /proc/\\$pid/stat 2>/dev/null; cat /proc/stat 2>/dev/null | head -n 1"`,
        );
        if (!out) return null;

        const lines = out
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean);
        if (lines[0] === "NOPROC") return "NOPROC";

        const pid = toNumber(lines[0]?.match(/^PID=(\d+)/)?.[1] ?? "");
        const procLine = lines.find((v) => /^\d+\s+\(.+\)\s+[A-Z]/i.test(v));
        const totalLine = lines.find((v) => /^cpu\s+/i.test(v));
        if (pid === null || !procLine || !totalLine) return null;

        const procFields = procLine.split(/\s+/);
        const totalFields = totalLine.split(/\s+/);
        const utime = Number(procFields[13] ?? NaN);
        const stime = Number(procFields[14] ?? NaN);
        const procTicks = utime + stime;
        const totalTicks = totalFields.slice(1).reduce((sum, cur) => sum + Number(cur || 0), 0);
        if (!Number.isFinite(procTicks) || !Number.isFinite(totalTicks)) return null;

        return {
            pid: Math.trunc(pid),
            procTicks,
            totalTicks,
        };
    };

    const computeProcCpuPercent = (prev: { pid: number; procTicks: number; totalTicks: number }, next: { pid: number; procTicks: number; totalTicks: number }): number | null => {
        if (prev.pid !== next.pid) return null;
        const dProc = next.procTicks - prev.procTicks;
        const dTotal = next.totalTicks - prev.totalTicks;
        if (dProc < 0 || dTotal <= 0) return null;
        // /proc/stat total 기준이므로 이미 단말 전체(0~100%) 비율
        const pct = (dProc / dTotal) * 100;
        return Number(Math.max(0, Math.min(100, pct)).toFixed(2));
    };

    // memory(MB): dumpsys meminfo 기반
    const memory: Sampler = async () => {
        const out = await execText(`adb -s ${udid} shell "dumpsys meminfo ${pkg} 2>/dev/null | grep -E 'No process found|TOTAL PSS:|TOTAL:' || true"`);
        if (out === null) return null;
        if (/no process found/i.test(out)) {
            return noProcessMemoryAsZero ? 0 : null;
        }
        const pssKb = toNumber((out.match(/TOTAL\s+PSS:\s*([\d,]+)/i)?.[1] ?? "").replace(/,/g, "")) ?? toNumber((out.match(/TOTAL:\s*([\d,]+)/i)?.[1] ?? "").replace(/,/g, ""));
        return pssKb === null ? null : Number((pssKb / 1024).toFixed(2));
    };

    // cpu(%): /proc delta -> dumpsys cpuinfo -> top 순으로 fallback
    const cpu: Sampler = async () => {
        // 1) /proc 기반 CPU 샘플 (pid/stat + /proc/stat delta)
        const current = await parseProcCpuSnapshot();
        if (current === "NOPROC") {
            lastProcCpu = null;
        } else if (current) {
            if (lastProcCpu && lastProcCpu.pid === current.pid) {
                const pct = computeProcCpuPercent(lastProcCpu, current);
                lastProcCpu = current;
                if (pct !== null) return pct;
            } else {
                // 첫 호출에서도 0으로 떨어지지 않게 짧은 간격으로 2차 샘플을 바로 취득
                lastProcCpu = current;
                await new Promise<void>((resolve) => setTimeout(resolve, 600));
                const second = await parseProcCpuSnapshot();
                if (second === "NOPROC") {
                    lastProcCpu = null;
                } else if (second && second.pid === current.pid) {
                    const pct = computeProcCpuPercent(current, second);
                    lastProcCpu = second;
                    if (pct !== null) return pct;
                } else if (second) {
                    lastProcCpu = second;
                }
            }
        }

        // 2) dumpsys cpuinfo fallback
        const out = await execText(`adb -s ${udid} shell "dumpsys cpuinfo | grep -F '${pkg}' || true"`);
        if (out) {
            let total = 0;
            let matched = 0;
            for (const line of out.split("\n")) {
                const pct = toNumber(line.match(/([\d.]+)%/)?.[1] ?? "");
                if (pct !== null) {
                    total += pct;
                    matched += 1;
                }
            }
            if (matched > 0) return normalizeCpu(total);
        }

        // 3) top fallback: PID 오인식 방지를 위해 % 패턴만 CPU로 인정
        const topOut = await execText(`adb -s ${udid} shell "top -n 1 -o %CPU,ARGS 2>/dev/null | grep -F '${pkg}' || top -n 1 2>/dev/null | grep -F '${pkg}' || true"`);
        if (topOut) {
            const pkgPattern = new RegExp(`(^|\\s)${escapeRegExp(pkg)}(:\\S*)?(\\s|$)`);
            let total = 0;
            let matched = 0;
            for (const line of topOut.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (!pkgPattern.test(trimmed)) continue;
                const pct = toNumber(trimmed.match(/\b(\d+(?:\.\d+)?)%/)?.[1] ?? "");
                if (pct === null) continue;
                total += pct;
                matched += 1;
            }
            if (matched > 0) return normalizeCpu(total);
        }

        // CPU 라인 미검출 시에도 지표 누락 방지를 위해 0 반환
        return 0;
    };

    const resetState = () => {
        lastProcCpu = null;
    };

    // current(mA): sysfs 우선, 불가 시 dumpsys battery fallback
    const current: Sampler = async () => {
        const out = await execText(
            `adb -s ${udid} shell "cat /sys/class/power_supply/battery/BatteryAverageCurrent 2>/dev/null || cat /sys/class/power_supply/battery/current_now 2>/dev/null || cat /sys/class/power_supply/battery/current_avg 2>/dev/null || echo ''"`,
        );
        let n = out === null ? null : toNumber(out);

        // 일부 단말에서는 /sys 경로 접근이 막혀 있어 dumpsys 배터리 값을 fallback로 사용.
        if (n === null) {
            const batteryDump = await execText(`adb -s ${udid} shell dumpsys battery`);
            if (batteryDump !== null) {
                n = toNumber(batteryDump.match(/current now:\s*(-?\d+)/i)?.[1] ?? "");
            }
        }
        if (n === null) return null;

        // 기본값에서는 충전 중 샘플을 제외하고,
        // PERF_CURRENT_MEASURE_WHILE_CHARGING=1 일 때만 포함한다.
        if (!allowChargingCurrent && (await isCharging())) return null;

        const signedMilliAmp = normalizeCurrentToMilliAmpSigned(n);

        // 소모 전류 관점으로 해석:
        // - signed < 0 : 배터리 방전(소모) 전류
        // - signed >= 0 : 충전/유입 전류 (소모가 아니므로 0 처리)
        if (signedMilliAmp >= 0) {
            return allowChargingCurrent ? 0 : null;
        }
        return Number(Math.abs(signedMilliAmp).toFixed(2));
    };

    return { memory, cpu, current, resetState };
}

// -----------------------------------------------------------------------------
// iOS 샘플러
// -----------------------------------------------------------------------------
export function createIosSamplers(options: IosSamplerOptions = {}): PerfSamplers {
    const udid = options.udid ?? IOS.udid;
    const deviceRef = options.deviceRef ?? process.env.IOS_SAMPLER_DEVICE_REF ?? udid;
    const bundleId = options.bundleId ?? IOS.bundleId;
    const memoryCmd = process.env.IOS_MEMORY_CMD;
    const cpuCmd = process.env.IOS_CPU_CMD;
    const currentCmd = process.env.IOS_CURRENT_CMD;
    const idevicePath = process.env.IOS_IDEVICE_PATH ?? "idevicediagnostics";
    const xctraceEnabled = String(process.env.PERF_IOS_USE_XCTRACE ?? "1") !== "0";
    const xctraceMs = Math.max(500, Number(process.env.PERF_IOS_XCTRACE_MS ?? 1200));
    const xctraceRecordTimeoutMs = Math.max(20_000, Number(process.env.PERF_IOS_XCTRACE_RECORD_TIMEOUT_MS ?? xctraceMs + 12_000));
    const xctraceExportTimeoutMs = Math.max(15_000, Number(process.env.PERF_IOS_XCTRACE_EXPORT_TIMEOUT_MS ?? 15_000));
    const allowChargingCurrent = !/^(0|false|no|off)$/i.test(String(process.env.PERF_CURRENT_MEASURE_WHILE_CHARGING ?? "1").trim());
    const processHints = options.processHints ?? [];
    const samplers: PerfSamplers = {};

    type Snapshot = { atMs: number; memoryMb: number | null; cpuPct: number | null };
    let latestSnapshot: Snapshot | null = null;
    let snapshotSeq = 0;
    let minSnapshotSeq = 0;
    let samplerEpoch = 0;
    let samplingEnabled = false;
    let loopAbort: AbortController | null = null;
    let loopPromise: Promise<void> | null = null;
    let lastPinnedLogKey = "";
    let lastCpuTotal: { atMs: number; totalNs: number; pid: number | null; name: string } | null = null;
    let pinnedProcess: { pid: number | null; name: string } | null = null;
    let hintTokensPromise: Promise<{
        primary: string[];
        secondary: string[];
    }> | null = null;
    let executableByPidCache: {
        atMs: number;
        byPid: Map<number, string>;
    } | null = null;

    const parseProcessName = (fmt: string): string =>
        fmt
            .replace(/\s*\(\d+\)\s*$/u, "")
            .trim()
            .toLowerCase();

    const toToken = (s: string): string =>
        s
            .toLowerCase()
            .replace(/[^a-z0-9가-힣._-]/gu, "")
            .trim();

    const tokenScore = (candidate: string, tokens: string[], exactWeight: number, containsWeight: number): number => {
        if (!candidate) return 0;
        let best = 0;
        for (const raw of tokens) {
            const token = toToken(raw);
            if (!token) continue;
            if (candidate === token) {
                best = Math.max(best, exactWeight + token.length);
                continue;
            }
            if (token.length >= 3 && (candidate.includes(token) || token.includes(candidate))) {
                best = Math.max(best, containsWeight + token.length);
            }
        }
        return best;
    };

    const executableToToken = (uri: string): string => {
        let normalizedPath = String(uri ?? "");
        try {
            normalizedPath = decodeURIComponent(normalizedPath);
        } catch {}
        normalizedPath = normalizedPath.replace(/^file:\/\//i, "").split("?")[0];
        const base = path.basename(normalizedPath);
        const withoutExt = base.replace(/\.[a-z0-9]+$/i, "");
        return toToken(withoutExt);
    };

    const addHintToken = (set: Set<string>, raw: string | null | undefined, minLen = 3) => {
        if (!raw) return;
        const normalized = toToken(raw);
        if (normalized && normalized.length >= minLen) set.add(normalized);
        for (const part of raw.split(/[.\s/_-]+/g)) {
            const t = toToken(part);
            if (t && t.length >= minLen) set.add(t);
        }
    };

    const parseRowProcess = (row: string): { name: string; pid: number | null } | null => {
        const processFmt = row.match(/<process[^>]*fmt="([^"]+)"/i)?.[1];
        if (processFmt) {
            const name = parseProcessName(processFmt);
            const pidValue = toNumber(processFmt.match(/\((\d+)\)\s*$/)?.[1] ?? "");
            const pid = pidValue === null ? null : Math.trunc(pidValue);
            return { name, pid };
        }
        return null;
    };

    const resolveHintTokens = async (): Promise<{
        primary: string[];
        secondary: string[];
    }> => {
        if (hintTokensPromise) return hintTokensPromise;
        hintTokensPromise = (async () => {
            const primary = new Set<string>();
            const secondary = new Set<string>();

            addHintToken(primary, bundleId, 3);
            const bundleParts = bundleId.split(".");
            const lastPart = bundleParts[bundleParts.length - 1] ?? "";
            addHintToken(primary, lastPart, 2);
            for (const part of bundleParts) {
                addHintToken(secondary, part, 4);
            }
            for (const hint of processHints) {
                addHintToken(primary, hint, 2);
            }
            return {
                primary: [...primary],
                secondary: [...secondary],
            };
        })();
        return hintTokensPromise;
    };

    const resolveExecutableByPid = async (): Promise<Map<number, string>> => {
        const now = Date.now();
        if (executableByPidCache && now - executableByPidCache.atMs < 3000) {
            return executableByPidCache.byPid;
        }

        const byPid = new Map<number, string>();
        try {
            const { stdout } = await execFileAsync("xcrun", ["devicectl", "device", "info", "processes", "--device", deviceRef, "--quiet", "--json-output", "-"], {
                encoding: "utf8",
                windowsHide: true,
                maxBuffer: 20 * 1024 * 1024,
                timeout: 6000,
            });
            const parsed = JSON.parse(String(stdout ?? "{}"));
            const processes = parsed?.result?.runningProcesses;
            if (Array.isArray(processes)) {
                for (const p of processes) {
                    const pid = Number(p?.processIdentifier);
                    const executable = String(p?.executable ?? "");
                    if (!Number.isFinite(pid) || !executable) continue;
                    const token = executableToToken(executable);
                    if (token) byPid.set(Math.trunc(pid), token);
                }
            }
        } catch {}

        executableByPidCache = { atMs: now, byPid };
        return byPid;
    };

    // xctrace 스냅샷 1회를 실행하고 CPU/Memory를 파싱한다.
    const runXctraceSnapshot = async (signal?: AbortSignal, epochAtStart?: number): Promise<Snapshot | null> => {
        if (!xctraceEnabled) return null;

        const tracePath = path.join(os.tmpdir(), `perf-ios-sampler-${process.pid}-${Date.now()}-${randomUUID()}.trace`);

        try {
            const recordArgs = [
                "xctrace",
                "record",
                "--template",
                "Activity Monitor",
                "--device",
                deviceRef,
                "--all-processes",
                "--time-limit",
                `${xctraceMs}ms`,
                "--output",
                tracePath,
                "--no-prompt",
            ];
            let recorded = false;
            let recordError: unknown = null;
            for (let attempt = 0; attempt < 2 && !recorded; attempt += 1) {
                try {
                    await execFileAsync("xcrun", recordArgs, {
                        encoding: "utf8",
                        windowsHide: true,
                        maxBuffer: 20 * 1024 * 1024,
                        timeout: xctraceRecordTimeoutMs,
                        signal,
                    });
                    recorded = true;
                } catch (e) {
                    recordError = e;
                    const err = e as any;
                    const abortLike = String(err?.name ?? "").toLowerCase() === "aborterror" || String(err?.code ?? "").toUpperCase() === "ABORT_ERR" || /abort/i.test(String(err?.message ?? e));
                    if (abortLike || attempt === 1) break;
                    await new Promise<void>((resolve) => setTimeout(resolve, 300));
                }
            }
            if (!recorded) {
                throw recordError ?? new Error("xctrace record failed");
            }

            const exportRows = async (xpath: string): Promise<string[]> => {
                try {
                    const { stdout } = await execFileAsync("xcrun", ["xctrace", "export", "--input", tracePath, "--xpath", xpath], {
                        encoding: "utf8",
                        windowsHide: true,
                        maxBuffer: 40 * 1024 * 1024,
                        timeout: xctraceExportTimeoutMs,
                        signal,
                    });
                    const xml = String(stdout ?? "");
                    return xml.match(/<row>[\s\S]*?<\/row>/g) ?? [];
                } catch {
                    // schema/table이 없는 경우가 있어 live 실패 시 빈 결과로 처리하고 ledger로 fallback한다.
                    return [];
                }
            };

            // live 테이블 우선, 없으면 ledger fallback
            let rows = await exportRows("/trace-toc/run/data/table[@schema='activity-monitor-process-live']");
            if (rows.length === 0) {
                rows = await exportRows("/trace-toc/run/data/table[@schema='activity-monitor-process-ledger']");
            }
            if (rows.length === 0) return null;
            if (epochAtStart !== undefined && epochAtStart !== samplerEpoch) {
                return null;
            }

            const { primary, secondary } = await resolveHintTokens();
            const executableByPid = await resolveExecutableByPid();

            type RowPick = { row: string; score: number };
            let pick: RowPick | null = null;
            let pinnedPick: RowPick | null = null;

            for (const row of rows) {
                const proc = parseRowProcess(row);
                if (!proc) continue;
                const name = proc.name;
                const normalized = toToken(name);
                if (!normalized) continue;
                if (/exited\s+process/i.test(name) || normalized === "exitedprocess") {
                    continue;
                }

                let score = tokenScore(normalized, primary, 120, 40) + tokenScore(normalized, secondary, 24, 8);

                if (proc.pid !== null) {
                    const executableToken = executableByPid.get(proc.pid);
                    if (executableToken) {
                        score += tokenScore(executableToken, primary, 140, 50);
                        score += tokenScore(executableToken, secondary, 20, 6);
                    }
                }

                const samePinned =
                    !!pinnedProcess &&
                    ((pinnedProcess.pid !== null && proc.pid !== null && pinnedProcess.pid === proc.pid) ||
                        (pinnedProcess.pid === null && proc.pid === null && pinnedProcess.name && proc.name && pinnedProcess.name === proc.name));
                if (samePinned) {
                    score += 400;
                }

                if (score <= 0) continue;

                if (!pick || score > pick.score || (score === pick.score && proc.pid !== null)) {
                    pick = { row, score };
                }

                if (samePinned) {
                    if (!pinnedPick || score > pinnedPick.score) {
                        pinnedPick = { row, score };
                    }
                }
            }

            if (pinnedPick) {
                pick = pinnedPick;
            }
            if (!pick) return null;

            const pickedProc = parseRowProcess(pick.row);
            if (pickedProc) {
                if (epochAtStart === undefined || epochAtStart === samplerEpoch) {
                    pinnedProcess = { pid: pickedProc.pid, name: pickedProc.name };
                }
                const pickedName = pickedProc?.name ?? "unknown";
                const pickedPid = pickedProc?.pid ?? "n/a";
                const logKey = `${pickedName}::${pickedPid}`;
                if (logKey !== lastPinnedLogKey) {
                    lastPinnedLogKey = logKey;
                    console.warn(`[ios-sampler] pinned process name=${pickedName} pid=${pickedPid} bundleId=${bundleId}`);
                }
            }

            const cpuDirect = toNumber(pick.row.match(/<cpu-percent[^>]*>(-?\d+(?:\.\d+)?)</i)?.[1] ?? pick.row.match(/<[^>]*cpu[^>]*(?:percent|pct|usage)[^>]*>(-?\d+(?:\.\d+)?)</i)?.[1] ?? "");
            const cpuTotalNs = toNumber(pick.row.match(/<duration-on-core[^>]*>(-?\d+)<\/duration-on-core>/i)?.[1] ?? "");

            // 메모리는 신뢰 가능한 필드(physical/resident)를 우선 사용해 저값 오탐을 줄인다.
            const physicalFootprintBytes = toNumber(pick.row.match(/<physical-footprint-in-bytes[^>]*>(-?\d+)</i)?.[1] ?? "");
            const residentSizeBytes = toNumber(pick.row.match(/<resident-size-in-bytes[^>]*>(-?\d+)</i)?.[1] ?? "");
            const trustedMemoryCandidates = [physicalFootprintBytes, residentSizeBytes].filter((v): v is number => v !== null && Number.isFinite(v)).map((v) => Math.abs(v));
            const fallbackMemoryCandidates = [
                toNumber(pick.row.match(/<[^>]*(?:footprint|resident|memory|rprvt)[^>]*>(-?\d+)</i)?.[1] ?? ""),
                toNumber(pick.row.match(/<size-in-bytes[^>]*>(-?\d+)<\/size-in-bytes>/i)?.[1] ?? ""),
            ]
                .filter((v): v is number => v !== null && Number.isFinite(v))
                .map((v) => Math.abs(v));
            const memoryBytes = trustedMemoryCandidates.length > 0 ? Math.max(...trustedMemoryCandidates) : fallbackMemoryCandidates.length > 0 ? Math.max(...fallbackMemoryCandidates) : null;

            const nowMs = Date.now();
            let cpuPct: number | null = null;
            if (cpuDirect !== null) {
                // xctrace cpu-percent는 이미 percent 단위로 해석한다.
                cpuPct = Number(Math.max(0, Math.min(cpuDirect, 400)).toFixed(2));
            } else if (cpuTotalNs !== null) {
                const currentPid = pickedProc?.pid ?? null;
                if (lastCpuTotal) {
                    const sameProcess = lastCpuTotal.pid !== null && currentPid !== null && lastCpuTotal.pid === currentPid;
                    const dtMs = nowMs - lastCpuTotal.atMs;
                    const dCpuNs = cpuTotalNs - lastCpuTotal.totalNs;
                    if (sameProcess && dtMs > 0 && dCpuNs >= 0) {
                        const rawPct = (dCpuNs / (dtMs * 1_000_000)) * 100;
                        cpuPct = Number(Math.max(0, Math.min(rawPct, 400)).toFixed(2));
                    }
                } else {
                    // 첫 샘플은 델타 계산 기준점으로만 사용한다.
                    cpuPct = null;
                }
                if (epochAtStart === undefined || epochAtStart === samplerEpoch) {
                    lastCpuTotal = {
                        atMs: nowMs,
                        totalNs: cpuTotalNs,
                        pid: currentPid,
                        name: pickedProc?.name ?? "",
                    };
                }
            }

            const memoryMb = memoryBytes === null ? null : Number((memoryBytes / (1024 * 1024)).toFixed(2));

            return { atMs: nowMs, memoryMb, cpuPct };
        } catch (e) {
            const err = e as any;
            const message = String(err?.message ?? e);
            const stderr = String(err?.stderr ?? "").trim();
            const abortLike = /abort/i.test(message) || /abort/i.test(stderr) || String(err?.name ?? "").toLowerCase() === "aborterror" || String(err?.code ?? "").toUpperCase() === "ABORT_ERR";
            if (abortLike) return null;
            const suffix = stderr ? ` stderr=${stderr}` : "";
            console.warn("[ios-sampler] xctrace snapshot failed:", `${message}${suffix}`);
            return null;
        } finally {
            try {
                fs.rmSync(tracePath, { recursive: true, force: true });
            } catch {}
        }
    };

    const xctraceLoopPauseMs = Math.max(50, Number(process.env.PERF_IOS_XCTRACE_LOOP_PAUSE_MS ?? 100));
    const xctraceStopWaitMs = Math.max(1000, Number(process.env.PERF_IOS_XCTRACE_STOP_WAIT_MS ?? xctraceMs + 2000));

    // 백그라운드 루프에서 최신 snapshot을 유지한다.
    const startSnapshotLoop = () => {
        if (!xctraceEnabled) return;
        if (loopPromise) return;

        const abort = new AbortController();
        loopAbort = abort;
        loopPromise = (async () => {
            while (!abort.signal.aborted) {
                const epochAtStart = samplerEpoch;
                const snap = await runXctraceSnapshot(abort.signal, epochAtStart);
                if (abort.signal.aborted || loopAbort !== abort) break;
                if (epochAtStart !== samplerEpoch) continue;
                if (snap) {
                    latestSnapshot = snap;
                    snapshotSeq += 1;
                }
                await sleepInterruptible(xctraceLoopPauseMs, abort.signal);
            }
        })().finally(() => {
            if (loopAbort === abort) loopAbort = null;
            loopPromise = null;
        });
    };

    const stopSnapshotLoop = async () => {
        if (!loopAbort && !loopPromise) return;
        loopAbort?.abort();
        const currentLoop = loopPromise;
        if (!currentLoop) return;
        try {
            const completed = await Promise.race([currentLoop.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), xctraceStopWaitMs))]);
            if (!completed && loopPromise === currentLoop) {
                loopPromise = null;
                if (loopAbort?.signal.aborted) loopAbort = null;
            }
        } catch {
            // no-op
        }
    };

    const resetState = () => {
        lastCpuTotal = null;
        samplerEpoch += 1;
        // snapshot 캐시는 유지하고, reset 이후 생성된 스냅샷부터 사용한다.
        minSnapshotSeq = snapshotSeq + 1;
    };

    const getSnapshot = async (): Promise<Snapshot | null> => {
        if (!xctraceEnabled) return null;
        if (!samplingEnabled) return null;
        startSnapshotLoop();

        const ready = () => latestSnapshot !== null && snapshotSeq >= minSnapshotSeq;

        if (ready()) return latestSnapshot;

        const deadline = Date.now() + xctraceMs + 3000;
        while (Date.now() < deadline) {
            if (!samplingEnabled) return null;
            if (ready()) return latestSnapshot;
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }

        return latestSnapshot;
    };

    const parseIdeviceCurrentRaw = (text: string): number | null => {
        return (
            toNumber(text.match(/InstantAmperage\s*=\s*(-?\d+)/i)?.[1] ?? "") ??
            toNumber(text.match(/AverageCurrent\s*=\s*(-?\d+)/i)?.[1] ?? "") ??
            toNumber(text.match(/Amperage\s*=\s*(-?\d+)/i)?.[1] ?? "")
        );
    };

    const parseIdeviceCharging = (text: string): boolean | null => {
        const isCharging = toNumber(text.match(/IsCharging\s*=\s*(\d+)/i)?.[1] ?? "") ?? toNumber(text.match(/ExternalConnected\s*=\s*(\d+)/i)?.[1] ?? "");
        if (isCharging === null) return null;
        return isCharging > 0;
    };

    // 1) 사용자 커맨드가 있으면 우선 사용
    // 2) 없으면 xctrace 내장 sampler 시도
    // memory sampler: 사용자 커맨드 우선, 없으면 xctrace snapshot 사용
    samplers.memory = async () => {
        if (memoryCmd) return execNumber(memoryCmd);

        const snap = await getSnapshot();
        if (snap?.memoryMb !== null && snap?.memoryMb !== undefined) {
            return snap.memoryMb;
        }
        return null;
    };

    // cpu sampler: 같은 snapshot 재사용을 피하고 다음 snapshot까지 대기 가능
    samplers.cpu = async () => {
        if (cpuCmd) return execNumber(cpuCmd);

        const first = await getSnapshot();
        if (first?.cpuPct !== null && first?.cpuPct !== undefined) {
            return first.cpuPct;
        }

        // 첫 스냅샷이 델타 기준점(cpuPct=null)일 수 있어
        // 같은 snapshot 재조회 대신 snapshot seq 증가를 기다린다.
        const fromSeq = snapshotSeq;
        const deadline = Date.now() + xctraceMs + 2000;
        while (Date.now() < deadline) {
            if (!samplingEnabled) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            if (snapshotSeq > fromSeq && latestSnapshot?.cpuPct !== null && latestSnapshot?.cpuPct !== undefined) {
                return latestSnapshot.cpuPct;
            }
        }
        return null;
    };

    // current sampler: 사용자 커맨드 우선, 없으면 idevicediagnostics 사용
    samplers.current = async () => {
        if (currentCmd) {
            const n = await execNumber(currentCmd);
            if (n === null) return null;
            const signedMilliAmp = normalizeCurrentToMilliAmpSigned(n);
            if (signedMilliAmp >= 0) {
                return allowChargingCurrent ? 0 : null;
            }
            return Number(Math.abs(signedMilliAmp).toFixed(2));
        }

        const readIdevice = async (args: string[]): Promise<string | null> => {
            try {
                const { stdout } = await execFileAsync(idevicePath, args, {
                    encoding: "utf8",
                    windowsHide: true,
                    maxBuffer: 5 * 1024 * 1024,
                    timeout: 5000,
                });
                return String(stdout ?? "");
            } catch {
                return null;
            }
        };

        // 빠른 경로: AppleSmartBattery 엔트리 직접 조회
        let out = await readIdevice(["-u", udid, "ioregentry", "AppleSmartBattery"]);
        // fallback: 전체 IORegistry 조회
        if (!out) {
            out = await readIdevice(["-u", udid, "diagnostics", "IORegistry"]);
        }
        if (!out) return null;

        const raw = parseIdeviceCurrentRaw(out);
        if (raw === null) {
            if (String(process.env.PERF_IOS_SAMPLER_DEBUG ?? "") === "1") {
                console.warn("[ios-sampler] idevicediagnostics: current field not found");
            }
            return null;
        }

        const charging = parseIdeviceCharging(out);
        if (charging === true && !allowChargingCurrent) return null;

        // USB 연결(충전) 환경에서도 샘플이 0으로 사라지지 않게 절대값으로 기록한다.
        const milliAmpAbs = Number(Math.abs(normalizeCurrentToMilliAmpSigned(raw)).toFixed(2));
        if (!Number.isFinite(milliAmpAbs)) return null;
        return milliAmpAbs;
    };
    samplers.resetState = resetState;
    samplers.startSampling = async () => {
        samplingEnabled = true;
        startSnapshotLoop();
    };
    samplers.stopSampling = async () => {
        samplingEnabled = false;
        await stopSnapshotLoop();
    };

    return samplers;
}

// -----------------------------------------------------------------------------
// 공통 export 헬퍼
// -----------------------------------------------------------------------------
export function currentPlatform(): PerfPlatform {
    const p = (process.env.PERF_PLATFORM ?? "ios").toLowerCase();
    return p === "aos" ? "aos" : "ios";
}

export function defaultSamplers(platform: PerfPlatform, options?: AosSamplerOptions): PerfSamplers {
    return platform === "aos" ? createAosSamplers(options) : createIosSamplers();
}

export function targetAppId(platform: PerfPlatform): string {
    return platform === "aos" ? AOS.appPackage : IOS.bundleId;
}
