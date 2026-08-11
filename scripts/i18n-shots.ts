/**
 * Localization screenshot capture (AQU-832) — regenerates the PNGs behind the
 * context sidecar.
 *
 * Iterates the `SCREENSHOTS` registry (`src/lib/i18n/screenshots.ts`) and
 * captures each surface from the live app into `<SCREENSHOT_DIR>/<id>.png`.
 * Every declared surface must have a driver in `scripts/i18n-shots/<namespace>.ts`
 * — a registry entry without one fails the run, and `context.test.ts` fails CI
 * first, so the registry and the capture set cannot drift.
 *
 * Usage: with the dev stack running (`pnpm dev`), run `pnpm i18n:shots` and
 * commit the changed PNGs. Signs in via the `/__dev/login` bypass (see
 * AGENTS.md "Local dev — auth bypass"); override the app origin with
 * I18N_SHOTS_BASE_URL when Vite is not on :5173.
 */

import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"
import { SCREENSHOT_DIR, SCREENSHOTS } from "../src/lib/i18n/screenshots"
import { DRIVERS } from "./i18n-shots/index"
import { BASE_URL } from "./i18n-shots/shared"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = join(REPO_ROOT, SCREENSHOT_DIR)
const VIEWPORT = { width: 1440, height: 900 }

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  // Sandboxed agent environments pre-install a Chromium that may not match the
  // pinned @playwright/test build — point at it explicitly when needed.
  const executablePath = process.env.I18N_SHOTS_CHROMIUM_PATH
  const browser = await chromium.launch(executablePath ? { executablePath } : {})
  const page = await browser.newPage({ viewport: VIEWPORT })
  try {
    // Sign in once: the bypass route seeds user `dev` + `dev-project` and
    // redirects into the workspace.
    await page.goto(`${BASE_URL}/__dev/login`)
    await page.waitForURL(/\/project\//, { timeout: 60_000 })

    for (const surface of SCREENSHOTS) {
      const drive = DRIVERS[surface.id]
      await drive(page)
      await page.screenshot({ path: join(OUT_DIR, `${surface.id}.png`) })
      console.log(`captured ${surface.id}.png — ${surface.title}`)
      // Leave any open dialog behind before the next surface.
      await page.keyboard.press("Escape")
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
