import { defineConfig, devices } from '@playwright/test'

// The tests open the HTML pages `ldfviz --open` writes, straight from disk,
// so they need a built CLI (`pnpm build`) and network access to the CDN scripts.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  expect: { timeout: 15_000 },
  timeout: 60_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
})
