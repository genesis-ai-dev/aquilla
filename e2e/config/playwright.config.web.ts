import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")
const positiveInteger = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const testTimeout = positiveInteger(process.env.E2E_TEST_TIMEOUT_MS, 60_000)
const globalTimeout = positiveInteger(process.env.E2E_GLOBAL_TIMEOUT_MS, 30 * 60_000)
const progressReporter = path.resolve(REPO_ROOT, "e2e/reporters/progress-reporter.ts")

export default defineConfig({
  testDir: path.resolve(REPO_ROOT, "e2e/specs"),
  // Tests within a shard share one auth-worker + sync-worker stack and one
  // Postgres database; /__test__/reset is not transactional. Parallel tests
  // would race while reseeding shared state, so keep each shard serial.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A retry is useful diagnostic evidence, but it must not turn an intermittent
  // failure green. The gate reports the first failure on every machine.
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], [progressReporter]]
    : [["line"], [progressReporter]],
  // Slow machines get enough room for real workflows, while a broken test is
  // still bounded. E2E_TEST_TIMEOUT_MS / E2E_GLOBAL_TIMEOUT_MS are explicit
  // escape hatches for unusually constrained CI hosts.
  timeout: testTimeout,
  globalTimeout,
  expect: { timeout: 10_000 },

  use: {
    // Defaults to the single-stack Vite port; scripts/e2e-up.ts overrides this
    // per shard (E2E_BASE_URL) so each isolated stack drives its own preview.
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  // No webServer here — scripts/e2e-up.ts owns boot (Task 5).
})
