import { execSync } from 'node:child_process';
import { AOS, IOS, type PerfPlatform } from './appium';
import { nowIso, writeMetric } from './metric';
import { generateSummaryArtifacts } from './summary';

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
  samplers: PerfSamplers;
  run: () => Promise<void>;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toNumber(text: string): number | null {
  const m = text.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
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
  category: 'e2e' | 'memory' | 'cpu' | 'current',
  platform: PerfPlatform,
  device: string,
  target: string,
  name: string,
  value: number,
  unit: string
) {
  writeMetric({ category, platform, device, target, name, value, unit, ts: nowIso() });
}

function toCaseKey(caseNo: number | string | undefined, caseName: string): string {
  if (caseNo === undefined || caseNo === null || String(caseNo).trim() === '') {
    return caseName;
  }
  return `${String(caseNo).trim()}::${caseName}`;
}

export async function runPerfCase(options: RunPerfOptions) {
  const { platform, deviceName, target, caseNo, caseName, run, samplers } = options;
  const sampleMs = options.sampleMs ?? 1500;
  const caseKey = toCaseKey(caseNo, caseName);

  const memoryBefore = await safeSample(samplers.memory);

  const cpuSamples: number[] = [];
  const currentSamples: number[] = [];
  let stopSampling = false;
  const cpuLoop = (async () => {
    while (!stopSampling) {
      const cpu = await safeSample(samplers.cpu);
      if (cpu !== null) cpuSamples.push(cpu);
      const current = await safeSample(samplers.current);
      if (current !== null) currentSamples.push(current);
      await sleep(sampleMs);
    }
  })();

  const startedAt = Date.now();
  await run();
  const e2eMs = Date.now() - startedAt;

  stopSampling = true;
  await cpuLoop;

  const memoryAfter = await safeSample(samplers.memory);

  pushMetric('e2e', platform, deviceName, target, `${caseKey}.duration`, e2eMs, 'ms');

  if (memoryAfter !== null) {
    pushMetric('memory', platform, deviceName, target, `${caseKey}.after`, memoryAfter, 'MB');
  }
  if (memoryBefore !== null && memoryAfter !== null) {
    pushMetric('memory', platform, deviceName, target, `${caseKey}.delta`, memoryAfter - memoryBefore, 'MB');
  }

  if (cpuSamples.length > 0) {
    const avg = cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length;
    pushMetric('cpu', platform, deviceName, target, `${caseKey}.avg`, Number(avg.toFixed(2)), '%');
  }
  if (currentSamples.length > 0) {
    const avg = currentSamples.reduce((a, b) => a + b, 0) / currentSamples.length;
    pushMetric('current', platform, deviceName, target, `${caseKey}.avg`, Number(avg.toFixed(2)), 'mA');
  }

  try {
    await generateSummaryArtifacts();
  } catch {}
}

function execNumber(command: string): number | null {
  try {
    const out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return toNumber(out);
  } catch {
    return null;
  }
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
    const out = execSync(`adb -s ${udid} shell dumpsys meminfo ${pkg}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pssKb =
      toNumber(out.match(/TOTAL\s+PSS:\s+(\d+)/)?.[1] ?? '') ??
      toNumber(out.match(/\bTOTAL\b\s+(\d+)\s+/m)?.[1] ?? '');
    return pssKb === null ? null : Number((pssKb / 1024).toFixed(2));
  };

  const cpu: Sampler = async () => {
    const out = execSync(`adb -s ${udid} shell dumpsys cpuinfo ${pkg}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const percent = toNumber(out.match(/([\d.]+)%/m)?.[1] ?? '');
    return percent === null ? null : Number(percent.toFixed(2));
  };

  const current: Sampler = async () => {
    const out = execSync(
      `adb -s ${udid} shell "cat /sys/class/power_supply/battery/current_now 2>/dev/null || cat /sys/class/power_supply/battery/BatteryAverageCurrent 2>/dev/null || echo ''"`,
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();
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
      const n = execNumber(currentCmd);
      return n === null ? null : normalizeCurrentToMilliAmp(n);
    };
  }

  return samplers;
}

export function currentPlatform(): PerfPlatform {
  const p = (process.env.PERF_PLATFORM ?? 'ios').toLowerCase();
  return p === 'aos' ? 'aos' : 'ios';
}

export function defaultSamplers(platform: PerfPlatform): PerfSamplers {
  return platform === 'aos' ? createAosSamplers() : createIosSamplers();
}

export function targetAppId(platform: PerfPlatform): string {
  return platform === 'aos' ? AOS.appPackage : IOS.bundleId;
}
