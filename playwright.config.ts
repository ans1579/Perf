import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30 * 60 * 1000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: 'test-output/results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-output/report' }],
  ],
});
