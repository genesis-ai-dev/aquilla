import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveProductionTimingTarget } from "../helpers/production-target"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

// Throws with the full list of missing/invalid variables if the probe has not
// been configured, so an unconfigured run fails at load with an actionable
// message instead of collecting zero tests.
const target = resolveProductionTimingTarget(process.env)

// The budgets are the assertions; these ceilings are stall watchdogs sized
// well above them so a slow deployment fails on its measured number rather
// than on a bare Playwright timeout that reports nothing useful.
const slowestBudgetMs = Math.max(target.loadBudgetMs, target.writeBudgetMs)

export default defineConfig({
  testDir: path.resolve(REPO_ROOT, "e2e/specs/production"),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A retry against a live deployment would mask exactly the intermittent
  // slowness this probe exists to surface.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: slowestBudgetMs * 4 + 60_000,
  globalTimeout: 10 * 60_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL: target.appOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // No video: this runs against a live deployment, often from CI, and the
    // trace already carries what a timing failure needs.
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  // No webServer: the target is a deployed environment, not a local stack.
})
