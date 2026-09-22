import { defineConfig } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: path.join(directory, "journeys"),
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 150_000,
  globalTimeout: 900_000,
  expect: { timeout: 10_000 },
  reporter: [["line"], [path.join(directory, "reporter.ts")]],
  outputDir: path.join(directory, "../test-results-smart"),
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173",
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Authentication and signed requests must not enter shared traces.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  // scripts/e2e-up.ts owns the stack and process cleanup.
})
