const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const res = spawnSync(
  isWin ? 'npx.cmd' : 'npx',
  ['playwright', 'test', '-c', 'playwright.config.ts', '--list'],
  {
    cwd: projectRoot,
    encoding: 'utf8',
  }
);

const stdout = res.stdout ?? '';
const stderr = res.stderr ?? '';
const output = `${stdout}\n${stderr}`;

if ((res.status ?? 1) !== 0 && /No tests found/i.test(output)) {
  // "No tests found"는 현재 tests/가 비어있는 상태에서 정상 시나리오이므로 성공 처리.
  const cleanedStderr = stderr
    .split(/\r?\n/)
    .filter((line) => !/^\s*Error:\s*No tests found/i.test(line))
    .join('\n')
    .trim();

  if (stdout) process.stdout.write(stdout);
  if (cleanedStderr) process.stderr.write(`${cleanedStderr}\n`);
  console.log('[test:list] No tests found. Treated as success.');
  process.exit(0);
}

if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

if (res.error) {
  console.error('[test:list] Failed to run playwright list:', res.error.message);
  process.exit(1);
}

process.exit(res.status ?? 1);
