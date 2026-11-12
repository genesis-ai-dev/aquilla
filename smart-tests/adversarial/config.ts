import { defineConfig } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertAdversarialTarget, attacksAllowed } from "./target"

const directory = path.dirname(fileURLToPath(import.meta.url))
// Refuse the wrong host before Playwright schedules anything.
const kind = assertAdversarialTarget(process.env)

export default defineConfig({
  testDir: path.join(directory, "journeys"),
  globalSetup: path.join(directory, "setup.ts"),
  // Tests share only the run org; each seeds its own projects, so they can
  // run in parallel against one deployed backend. The local stack keeps one
  // worker per database, like the cooperative suite.
  fullyParallel: true,
  workers: Number(process.env.ADVERSARIAL_WORKERS ?? (kind === "local" ? 1 : 12)),
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 180_000,
  globalTimeout: 45 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["line"],
    [path.join(directory, "../reporter.ts")],
    [path.join(directory, "run-reporter.ts")],
  ],
  outputDir: path.join(directory, "../../test-results-adversarial"),
  use: {
    baseURL: process.env.E2E_BASE_URL,
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Sessions and signed requests must not enter traces or artifacts.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "canary", testMatch: /canary\.spec\.ts/ },
    // The health gate: attacks run only when the canary passed.
    ...(attacksAllowed(kind)
      ? [{ name: "attacks", testMatch: /attacks\.spec\.ts/, dependencies: ["canary"] }] : []),
  ],
})
