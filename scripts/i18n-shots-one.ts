/**
 * Scratch single-surface capture for iterating on a driver (AQU-511).
 *
 * `pnpm tsx scripts/i18n-shots-one.ts <surface-id> [outDir]` runs the same
 * prologue as `i18n-shots.ts` (dev login, content seed) but drives exactly one
 * surface and writes the PNG to `outDir` (default: a scratch dir, NOT the
 * committed screenshots dir), so a half-working driver cannot land a bad
 * artifact. On failure it dumps the page's visible text to help see what state
 * it actually reached.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { DRIVERS } from "./i18n-shots/index"
import { BASE_URL, setDevOrgId } from "./i18n-shots/shared"
import { devSession, seedShotsFile } from "./i18n-shots/seed"

const VIEWPORT = { width: 1440, height: 900 }

async function main(): Promise<void> {
  const id = process.argv[2]
  const outDir = process.argv[3] || "/tmp/i18n-shots-scratch"
  if (!id || !DRIVERS[id]) {
    throw new Error(`usage: i18n-shots-one.ts <surface-id>; known: ${Object.keys(DRIVERS).join(", ")}`)
  }
  mkdirSync(outDir, { recursive: true })

  const session = await devSession()
  setDevOrgId(session.orgId)
  const seeded = await seedShotsFile(session.jwt)
  console.log(`seeded file ${seeded.fileId} (${seeded.cellIds.length} cells), org ${session.orgId}`)

  const executablePath = process.env.I18N_SHOTS_CHROMIUM_PATH
  const browser = await chromium.launch(executablePath ? { executablePath } : {})
  const page = await browser.newPage({ viewport: VIEWPORT })
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[page error] ${m.text().slice(0, 300)}`)
  })
  try {
    if (id !== "auth") {
      await page.goto(`${BASE_URL}/__dev/login`)
      await page.waitForURL(/\/project\//, { timeout: 60_000 })
    }
    try {
      await DRIVERS[id](page)
    } catch (err) {
      console.error(`driver "${id}" failed:`, err instanceof Error ? err.message : err)
      console.log("---- url ----")
      console.log(page.url())
      console.log("---- visible text ----")
      console.log((await page.locator("body").innerText().catch(() => "<none>")).slice(0, 4000))
      writeFileSync(join(outDir, `${id}.FAILED.png`), await page.screenshot())
      process.exitCode = 1
      return
    }
    writeFileSync(join(outDir, `${id}.png`), await page.screenshot())
    console.log(`wrote ${join(outDir, `${id}.png`)}`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
