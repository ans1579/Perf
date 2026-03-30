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

function mergeSamplers(base: PerfSamplers, override?: PerfSamplers): PerfSamplers {
    return {
        memory: override?.memory ?? base.memory,
        cpu: override?.cpu ?? base.cpu,
        current: override?.current ?? base.current,
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

    const base = createIosSamplers();
    return mergeSamplers(base, options.samplers);
}

export async function runPerfCase(options: RunPerfOptions) {
    const {
        platform,
        deviceName,
        target,
        caseNo,
        caseName,
        run,
        beforeRun,
        afterRun,
        writeSummary = true,
    } = options;
    const samplers = resolveSamplers(options);
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
        4,
    );
    const strictSampleGate = /^(1|true|yes|y|on)$/i.test(
        String(process.env.PERF_SAMPLE_GATE_STRICT ?? "").trim(),
    );

    const runMeasuredOnce = async () => {
        if (beforeRun) await beforeRun();

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
    let lastMeasured: {
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
        lastMeasured = measured;

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
        if (strictSampleGate || !lastMeasured) {
            throw new Error(
                `sample gate failed for "${caseKey}" after ${sampleGateRetries + 1} attempts (${lastGateMessage})`,
            );
        }
        accepted = lastMeasured;
        console.warn(
            `[perf] sample gate relaxed for "${caseKey}" (${lastGateMessage})`,
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

function normalizeCurrentToMilliAmpSigned(raw: number): number {
    const sign = raw < 0 ? -1 : 1;
    const abs = Math.abs(raw);
    // Device마다 current 계열 단위가 다를 수 있어 큰 값은 uA로 보고 mA로 변환.
    const milliAmp = abs >= 5000 ? abs / 1000 : abs;
    return Number((milliAmp * sign).toFixed(2));
}

export function createAosSamplers(options: AosSamplerOptions = {}): PerfSamplers {
    const udid = options.udid ?? AOS.udid;
    const pkg = options.appPackage ?? AOS.appPackage;
    const noProcessMemoryAsZero = options.noProcessMemoryAsZero ?? true;
    // 기본값: 앱 코어합 CPU를 단말 전체 기준(0~100%)으로 정규화
    const normalizeCpuByCores = !/^(0|false|no|off)$/i.test(
        String(process.env.PERF_CPU_NORMALIZE_BY_CORES ?? "1").trim(),
    );
    const allowChargingCurrent = !/^(0|false|no|off)$/i.test(
        String(
            process.env.PERF_CURRENT_MEASURE_WHILE_CHARGING ?? "1",
        ).trim(),
    );
    let cachedCharging = false;
    let cachedChargingCheckedAt = 0;
    let cachedCpuCores: number | null = null;

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
        const out = await execText(
            `adb -s ${udid} shell "nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1"`,
        );
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

    const memory: Sampler = async () => {
        const out = await execText(
            `adb -s ${udid} shell dumpsys meminfo ${pkg}`,
        );
        if (out === null) return null;
        if (/no process found/i.test(out)) {
            return noProcessMemoryAsZero ? 0 : null;
        }
        const pssKb =
            toNumber(out.match(/TOTAL\s+PSS:\s+(\d+)/)?.[1] ?? "") ??
            toNumber(
                (out.match(/TOTAL PSS:\s*([\d,]+)/i)?.[1] ?? "").replace(
                    /,/g,
                    "",
                ),
            ) ??
            toNumber(out.match(/\bTOTAL\b\s+(\d+)\s+/m)?.[1] ?? "");
        return pssKb === null ? null : Number((pssKb / 1024).toFixed(2));
    };

    const cpu: Sampler = async () => {
        // 1) top에서 앱 프로세스 라인 집계 (단말별로 가장 안정적)
        const topOut = await execText(
            `adb -s ${udid} shell "top -n 1 -b -o %CPU,ARGS | grep '${pkg}' || true"`,
        );
        if (topOut) {
            let total = 0;
            let matched = 0;
            for (const line of topOut.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const m = trimmed.match(/^([\d.]+)\s+(\S+)/);
                if (!m) continue;
                const cpu = Number(m[1]);
                const args = m[2];
                if (!Number.isFinite(cpu)) continue;
                if (args === pkg || args.startsWith(`${pkg}:`)) {
                    total += cpu;
                    matched += 1;
                }
            }
            if (matched > 0) return normalizeCpu(total);
        }

        // 2) fallback: dumpsys cpuinfo에서 앱 라인 집계
        const out = await execText(
            `adb -s ${udid} shell "dumpsys cpuinfo | grep '${pkg}' || true"`,
        );
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

        // CPU 라인 미검출 시에도 지표 누락 방지를 위해 0 반환
        return 0;
    };

    const current: Sampler = async () => {
        const out = await execText(
            `adb -s ${udid} shell "cat /sys/class/power_supply/battery/BatteryAverageCurrent 2>/dev/null || cat /sys/class/power_supply/battery/current_now 2>/dev/null || cat /sys/class/power_supply/battery/current_avg 2>/dev/null || echo ''"`,
        );
        let n = out === null ? null : toNumber(out);

        // 일부 단말에서는 /sys 경로 접근이 막혀 있어 dumpsys 배터리 값을 fallback로 사용.
        if (n === null) {
            const batteryDump = await execText(
                `adb -s ${udid} shell dumpsys battery`,
            );
            if (batteryDump !== null) {
                n = toNumber(
                    batteryDump.match(/current now:\s*(-?\d+)/i)?.[1] ?? "",
                );
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
            if (n === null) return null;
            const signedMilliAmp = normalizeCurrentToMilliAmpSigned(n);
            if (signedMilliAmp >= 0) return null;
            return Number(Math.abs(signedMilliAmp).toFixed(2));
        };
    }

    return samplers;
}

export function currentPlatform(): PerfPlatform {
    const p = (process.env.PERF_PLATFORM ?? "ios").toLowerCase();
    return p === "aos" ? "aos" : "ios";
}

export function defaultSamplers(
    platform: PerfPlatform,
    options?: AosSamplerOptions,
): PerfSamplers {
    return platform === "aos"
        ? createAosSamplers(options)
        : createIosSamplers();
}

export function targetAppId(platform: PerfPlatform): string {
    return platform === "aos" ? AOS.appPackage : IOS.bundleId;
}
