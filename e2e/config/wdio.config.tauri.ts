import path from "node:path"
import { fileURLToPath } from "node:url"
import { createTauriCapabilities } from "@wdio/tauri-service"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

// `pnpm run tauri:build:e2e` (src-tauri built with --debug --no-bundle --features
// e2e-webdriver) always produces this path; only the executable's extension differs
// on Windows. This suite never runs against a signed/bundled build.
const appBinaryPath = path.resolve(
  REPO_ROOT,
  "src-tauri/target/debug",
  process.platform === "win32" ? "app.exe" : "app",
)

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: [path.resolve(REPO_ROOT, "e2e/tauri/**/*.spec.ts")],

  capabilities: [createTauriCapabilities(appBinaryPath, { driverProvider: "embedded" })],

  services: [["tauri", { appBinaryPath, driverProvider: "embedded" }]],

  framework: "mocha",
  mochaOpts: {
    timeout: 60_000,
  },
  reporters: ["spec"],

  // A retry is useful diagnostic evidence, but it must not turn an intermittent
  // failure green — same rule e2e/README.md states for the web smoke suite.
  // This is a release gate (tauri-release.yml), not a push gate: a red run
  // blocks that OS's signed build/publish rather than masking a real bug.
  connectionRetryTimeout: 15_000,
  connectionRetryCount: 0,
  waitforTimeout: 10_000,
}
