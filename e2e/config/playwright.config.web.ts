import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

export default defineConfig({
  testDir: path.resolve(REPO_ROOT, "e2e/specs"),
  // Tests share a single backend (frontier-server + sync-worker), and the
  // /__test__/reset hook is not transactional. Parallel execution races on
  // the shared D1 → UNIQUE-constraint failures on seed reinsertion. Keep
  // serial until/unless we move to per-worker backends.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  // Playwright's default (30s). The previous 15s budget predates the fresh-
  // project flow getting heavier (org Overview hop + setup checklist + import
  // projection round-trip) — a typical create→open→import→edit spec now needs
  // ~20s legitimately. Specs that need more can override locally with
  // `test.setTimeout(...)`.
  timeout: 30_000,

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
