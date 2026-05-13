import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

export default defineConfig({
  testDir: path.resolve(REPO_ROOT, "e2e/specs"),
  // Tests share a single backend (codex-auth-worker + sync-worker), and the
  // /__test__/reset hook is not transactional. Parallel execution races on
  // the shared D1 → UNIQUE-constraint failures on seed reinsertion. Keep
  // serial until/unless we move to per-worker backends.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  // Tighter than Playwright's 30s default. Most legitimate operations finish
  // in 1-3s; a 60s ceiling × 9 specs × workers=1 means a fully-failing run
  // wastes 9 minutes before reporting. Specs that genuinely need more time
  // can override locally with `test.setTimeout(...)`.
  timeout: 15_000,

  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  // No webServer here — scripts/e2e-up.ts owns boot (Task 5).
})
