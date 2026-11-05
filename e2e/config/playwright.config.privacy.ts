import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
export default defineConfig({
  testDir: "../privacy",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: { actionTimeout: 15_000, navigationTimeout: 30_000, baseURL: "http://127.0.0.1:6173", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node e2e/privacy/collector.cjs",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:9999/_audit",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
})
