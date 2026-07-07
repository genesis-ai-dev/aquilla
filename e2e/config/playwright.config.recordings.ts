import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

// Recording harness config — distinct from playwright.config.web.ts.
//
// The e2e config optimizes for fast, headless correctness checks (video only
// retained on failure). This config optimizes for *legible marketing footage*:
// video always on at a fixed 1280×800 frame, deliberate pacing (slowMo) so a
// viewer can follow each action, and traces on for debugging a bad take.
//
// Boot it through the same backend pipeline as e2e:
//   E2E_CONFIG=e2e/config/playwright.config.recordings.ts tsx scripts/e2e-up.ts -- e2e/recordings
// (or `npm run record`). Output lands in e2e/recordings/output/.
const FRAME = { width: 1280, height: 800 }

// Pacing is overridable so a quick "does it run" pass can drop slowMo to 0.
const SLOW_MO = Number(process.env.RECORD_SLOWMO ?? 350)

export default defineConfig({
  testDir: path.resolve(REPO_ROOT, "e2e/recordings/specs"),
  testMatch: /.*\.showcase\.ts/,
  outputDir: path.resolve(REPO_ROOT, "e2e/recordings/output"),
  // Marketing takes are sequential by nature and share the single backend.
  fullyParallel: false,
  workers: 1,
  // A bad take should fail loudly, not silently retry into a different cut.
  retries: 0,
  reporter: "list",
  // slowMo + deliberate caption holds stretch a full journey; give generous
  // headroom so a take never truncates mid-story.
  timeout: 300_000,

  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: FRAME,
    trace: "on",
    screenshot: "on",
    video: { mode: "on", size: FRAME },
    launchOptions: {
      slowMo: SLOW_MO,
      // Fake media so Voice Studio / recording journeys can capture a take
      // headlessly without a real mic, and never block on a permission prompt.
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // No webServer — scripts/e2e-up.ts owns backend boot (same as the e2e config).
})
