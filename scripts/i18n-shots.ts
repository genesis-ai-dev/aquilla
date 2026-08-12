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
 * AGENTS.md "Local dev — auth bypass").
 *
 * Env overrides, all needed together when the stack is not on its default
 * ports (e.g. a second worktree running a parallel stack):
 *   I18N_SHOTS_BASE_URL        Vite origin              (default :5173)
 *   I18N_SHOTS_IDENTITY_BASE   auth-worker origin       (default :8788)
 *   I18N_SHOTS_SYNC_BASE       sync-worker origin       (default :8789)
 *   I18N_SHOTS_CHROMIUM_PATH   explicit Chromium binary
 *
 * Two things this script owns beyond the loop:
 *
 *   1. CONTENT. `/__dev__/seed` creates the dev user/org/project but no files
 *      and no cells, so most surfaces would render empty-state placeholders.
 *      `seedShotsFile()` puts a small bilingual sample file in `dev-project`
 *      first (idempotent) — see `i18n-shots/seed.ts`.
 *   2. ISOLATION. Each surface gets a fresh browser context. Surfaces leave
 *      state behind (an open dock, a confirm row mid-flow, a selected cell),
 *      and a single shared page made every shot depend on the order of the one
 *      before it. It also lets the `auth` surface run genuinely signed out
 *      instead of being bounced to the workspace by an existing session.
 */

import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "@playwright/test"
import { SCREENSHOT_DIR, SCREENSHOTS } from "../src/lib/i18n/screenshots"
import { DRIVERS, SIGNED_OUT_SURFACE_IDS } from "./i18n-shots/index"
import { devSession, seedShotsFile } from "./i18n-shots/seed"
import { BASE_URL, setDevOrgId } from "./i18n-shots/shared"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = join(REPO_ROOT, SCREENSHOT_DIR)
const VIEWPORT = { width: 1440, height: 900 }

async function captureSurface(
  browser: Browser,
  id: string,
  title: string,
): Promise<void> {
  const drive = DRIVERS[id]
  if (!drive) {
    throw new Error(
      `surface "${id}" is declared in SCREENSHOTS but has no driver in scripts/i18n-shots/`,
    )
  }
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  try {
    if (!SIGNED_OUT_SURFACE_IDS.includes(id)) {
      await page.goto(`${BASE_URL}/__dev/login`)
      await page.waitForURL(/\/project\//, { timeout: 60_000 })
    }
    await drive(page)
    await page.screenshot({ path: join(OUT_DIR, `${id}.png`) })
    console.log(`captured ${id}.png — ${title}`)
  } catch (err) {
    // Say which surface broke and where it got to — a bare Playwright timeout
    // does not identify the driver, and the run stops here.
    throw new Error(
      `surface "${id}" failed at ${page.url()}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  } finally {
    await context.close()
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })

  // Seed before the browser starts: the org id is only knowable from the login
  // response, and drivers read it through requireDevOrgId().
  const session = await devSession()
  setDevOrgId(session.orgId)
  const seeded = await seedShotsFile(session.jwt)
  console.log(`seeded ${seeded.fileName} (${seeded.cellIds.length} cells) in dev-project`)

  // Sandboxed agent environments pre-install a Chromium that may not match the
  // pinned @playwright/test build — point at it explicitly when needed.
  const executablePath = process.env.I18N_SHOTS_CHROMIUM_PATH
  const browser = await chromium.launch(executablePath ? { executablePath } : {})
  try {
    for (const surface of SCREENSHOTS) {
      await captureSurface(browser, surface.id, surface.title)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
