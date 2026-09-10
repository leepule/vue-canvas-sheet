/**
 * Vue-Canvas-Sheet E2E Test Configuration
 *
 * Playwright 配置：Chromium-only，确定性 Canvas 渲染，内置视觉回归支持。
 */
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 8899;
const BASE_URL = `http://localhost:${PORT}`;
const browserChannel = process.env.CI ? {} : { channel: 'chrome' as const };

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'e2e/playwright-report', open: 'never' }]]
    : 'list',
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      threshold: 0.2,
      maxDiffPixelRatio: 0.01,
    },
  },

  // 仅 Chromium：确保 Canvas 渲染确定性
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 本地复用系统 Chrome；CI 使用由 Playwright 固定版本管理的 Chromium。
        ...browserChannel,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      },
    },
  ],

  // 自动启动 Vite dev server（使用 e2e/app 目录，显式指定根 vite.config.js）
  webServer: {
    command: `npx vite serve e2e/app --config ./vite.config.js --port ${PORT} --strictPort`,
    cwd: path.resolve(__dirname, '..'),
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 5_000,
    },
  },

  // 基线截图存储于 e2e/fixtures/baselines（相对于 config 文件）
  snapshotDir: './fixtures/baselines',

  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    timezoneId: 'UTC',
    permissions: ['clipboard-read', 'clipboard-write'],
    // 失败时保留 trace / screenshot（video 需 ffmpeg，默认关闭）
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--font-render-hinting=none',
        '--disable-font-subpixel-positioning',
      ],
    },
  },
});
