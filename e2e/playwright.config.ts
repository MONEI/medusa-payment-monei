import { defineConfig, devices } from "@playwright/test";
import { STOREFRONT_URL } from "./utils/env.ts";

const chrome = devices["Desktop Chrome"];
const PAYPAL = /paypal.*\.spec\.ts$/;
const VISUAL = /payment-methods-rendering\.spec\.ts$/;
const AUTH = /\.auth\.spec\.ts$/;
const VISUAL_BROWSER = "ws://127.0.0.1:13333/";

/**
 * The suite pays against one real MONEI test account through one backend whose capture
 * mode the AUTH project switches, so it runs single worker and never in parallel.
 */
export default defineConfig({
  testDir: "./specs",
  outputDir: "./test-results",
  globalSetup: "./utils/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Hosted pages, 3DS and the callback round trip all sit inside one test.
  timeout: 180_000,
  // Baselines are rendered in the official Playwright Docker image, locally and on CI.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-linux{ext}",
  // Locally a missing baseline is written; on CI it fails instead of passing silently.
  updateSnapshots: process.env.CI ? "none" : "missing",
  expect: {
    timeout: 30_000,
    toHaveScreenshot: { threshold: 0.3, maxDiffPixelRatio: 0.1, animations: "disabled" },
  },
  reporter: [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]],
  use: {
    baseURL: STOREFRONT_URL,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", testIgnore: [PAYPAL, VISUAL, AUTH], use: chrome },
    // The PayPal sandbox is unstable.
    {
      name: "paypal",
      testMatch: PAYPAL,
      testIgnore: AUTH,
      retries: process.env.CI ? 1 : 0,
      use: chrome,
    },
    // A comparison that passes on a second attempt is nondeterministic.
    {
      name: "visual",
      testMatch: VISUAL,
      retries: 0,
      use: { ...chrome, connectOptions: { wsEndpoint: VISUAL_BROWSER } },
    },
    // AUTH specs run in their own invocation after the others (scripts/run.sh): their
    // fixture (utils/auth.ts) recreates the backend with MONEI_CAPTURE=false and the global
    // teardown puts SALE back.
    { name: "auth", testMatch: AUTH, use: chrome },
  ],
});
