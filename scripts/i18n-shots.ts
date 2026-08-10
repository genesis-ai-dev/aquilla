/**
 * Localization screenshot capture (AQU-832) — regenerates the PNGs behind the
 * context sidecar.
 *
 * Iterates the `SCREENSHOTS` registry (`src/lib/i18n/screenshots.ts`) and
 * captures each surface from the live app into `<SCREENSHOT_DIR>/<id>.png`.
 * Every declared surface must have a driver below — a registry entry without
 * one fails the run, so the registry and the capture set cannot drift.
 *
 * Usage: with the dev stack running (`pnpm dev`), run `pnpm i18n:shots` and
 * commit the changed PNGs. Signs in via the `/__dev/login` bypass (see
 * AGENTS.md "Local dev — auth bypass"); override the app origin with
 * I18N_SHOTS_BASE_URL when Vite is not on :5173.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "@playwright/test"
import { SCREENSHOT_DIR, SCREENSHOTS, type ScreenshotId } from "../src/lib/i18n/screenshots"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = join(REPO_ROOT, SCREENSHOT_DIR)
const BASE_URL = process.env.I18N_SHOTS_BASE_URL || "http://127.0.0.1:5173"
const VIEWPORT = { width: 1440, height: 900 }
/** The dev-bypass seed project + org (auth-worker `/__dev__/seed`). */
const DEV_PROJECT = "dev-project"
const DEV_ORG_ID = 1

/**
 * One driver per declared surface: navigate to the state the surface describes,
 * settle on an observable element, and leave the page ready for a screenshot.
 */
const DRIVERS: Record<ScreenshotId, (page: Page) => Promise<void>> = {
  "workspace-nav": async (page) => {
    // The seeded org's project list: sidebar + top chrome + project cards.
    await page.goto(`${BASE_URL}/orgs/${DEV_ORG_ID}`)
    await page.getByRole("button", { name: /new project/i }).first().waitFor({ timeout: 30_000 })
  },
  "cell-editor": async (page) => {
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/editor`)
    // The seed project ships empty; import a tiny text file through the real
    // upload flow so the shot shows the editing table, not the empty state.
    const emptyCta = page.getByRole("button", { name: /import a file/i })
    const cell = page.getByText("In the beginning God created", { exact: false }).first()
    await emptyCta.or(cell).first().waitFor({ timeout: 30_000 })
    if (await emptyCta.isVisible().catch(() => false)) {
      const samplePath = join(tmpdir(), "i18n-shots-sample.txt")
      writeFileSync(
        samplePath,
        "In the beginning God created the heavens and the earth.\n" +
          "And God said, Let there be light: and there was light.\n",
      )
      await emptyCta.click()
      await page.getByRole("dialog").waitFor({ timeout: 10_000 })
      await page.getByText("Upload files", { exact: true }).click()
      const fileInput = page.locator('input[type="file"]').first()
      await fileInput.waitFor({ state: "attached", timeout: 10_000 })
      await fileInput.setInputFiles(samplePath)
      await page.getByRole("button", { name: /confirm import/i }).click()
      await cell.waitFor({ timeout: 60_000 })
      // First import prompts for translation direction — not this surface.
      const skipDirection = page.getByRole("button", { name: /skip for now/i })
      if (await skipDirection.isVisible().catch(() => false)) {
        await skipDirection.click()
        await skipDirection.waitFor({ state: "hidden", timeout: 10_000 })
      }
    }
  },
  "confirm-dialog": async (page) => {
    // The project-card delete flow is the canonical confirm/cancel pattern.
    // Cancelled after capture — nothing is deleted.
    // Remove-target-lane is the canonical destructive confirm ("Confirm
    // remove" / cancel). A throwaway lane is added if none exists; the dialog
    // is dismissed after capture, so project state is unchanged.
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/settings/general`)
    const removeLane = page
      .locator('[data-testid^="remove-lane-"], [data-testid^="archive-lane-"]')
      .first()
    const addLaneInput = page.getByTestId("add-target-lang-input")
    await removeLane.or(addLaneInput).first().waitFor({ timeout: 30_000 })
    if (!(await removeLane.isVisible().catch(() => false))) {
      await addLaneInput.fill("fr")
      await page.getByTestId("add-target-lang-btn").click()
      await removeLane.waitFor({ timeout: 10_000 })
    }
    await removeLane.click()
    await page.getByRole("button", { name: /^Confirm/i }).waitFor({ timeout: 10_000 })
  },
  "project-settings": async (page) => {
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/settings`)
    await page.getByRole("heading").first().waitFor({ timeout: 30_000 })
  },
  "error-state": async (page) => {
    // A project id that cannot exist renders the workspace failure surface.
    await page.goto(`${BASE_URL}/project/i18n-shots-no-such-project/editor`)
    await page
      .getByText(/went wrong|not found|no longer have access|couldn.t|failed|error/i)
      .first()
      .waitFor({ timeout: 30_000 })
  },
}

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
