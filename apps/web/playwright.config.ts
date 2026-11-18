import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3798;
const MOCK_PORT = 4910;
const dataDir = path.resolve(import.meta.dirname, `e2e/.data-${Date.now()}`);

/**
 * Runs the real (built) server against a fake OpenAI-compatible provider.
 * Requires `pnpm build` first (CI does it).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    // smoke creates the account and the connections; the reports spec reuses them
    {
      name: 'chromium',
      testIgnore: /(reports|tests)\.spec/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'reports',
      testMatch: /reports\.spec/,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'tests',
      testMatch: /tests\.spec/,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `node e2e/mock-provider.mjs ${MOCK_PORT}`,
      port: MOCK_PORT,
      reuseExistingServer: false,
    },
    {
      command: 'node ../server/dist/main.js',
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'production',
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        WEB_DIR: path.resolve(import.meta.dirname, 'dist'),
        MIGRATIONS_DIR: path.resolve(import.meta.dirname, '../server/drizzle'),
        THINKFLOW_SECRET: 'e2e-secret',
        LOG_LEVEL: 'warn',
      },
    },
  ],
});
