import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: '../output/playwright/test-results',
  fullyParallel: false,
  // Both projects intentionally exercise the same seeded learner. Keep them serialized so the
  // one-running-timer invariant is tested without one browser invalidating the other's UI state.
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: '../output/playwright/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4200',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'make db-up migrate seed api-run',
      cwd: '..',
      url: 'http://127.0.0.1:8080/api/ready',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm start -- --host 127.0.0.1',
      cwd: '.',
      url: 'http://127.0.0.1:4200',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'desktop-chrome',
      use: { browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'ipad-portrait-webkit',
      use: {
        browserName: 'webkit',
        viewport: { width: 1024, height: 1366 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
