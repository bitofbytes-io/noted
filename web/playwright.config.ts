import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: process.env['NOTED_E2E_BASE_URL'] || 'http://127.0.0.1:4200',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env['NOTED_E2E_COMMAND'] || 'npm start -- --host 127.0.0.1 --port 4200',
    url: process.env['NOTED_E2E_BASE_URL'] || 'http://127.0.0.1:4200',
    reuseExistingServer: !process.env['NOTED_E2E_COMMAND'],
    timeout: 120_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'ipad-webkit',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1024, height: 1366 },
      },
    },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'] } },
    {
      name: 'phone-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
