import { defineConfig, devices } from "@playwright/test";

// Browser end-to-end tests (tests/e2e). They run against the local test stack only:
// the app built into .next-test and served on :3100 by `npm run test:env -- npx next start -p 3100`
// (see docs/TESTING.md). Nothing here starts, builds or resets anything.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

// Never point these tests at production: they create accounts, listings and deals.
const host = new URL(baseURL).hostname;
if (!["localhost", "127.0.0.1"].includes(host)) {
  throw new Error(`E2E_BASE_URL must be a local address, got ${baseURL}`);
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A failure blocks on its first attempt; flakes get fixed, not retried away
  retries: 0,
  // The app and the database are shared with other local work: keep the load modest
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    timezoneId: "America/New_York",
    locale: "en-US",
  },
  projects: [
    {
      name: "mobile",
      // iPhone 13 viewport, touch and user agent, rendered by Chromium
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
});
