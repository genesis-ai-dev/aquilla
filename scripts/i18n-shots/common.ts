/**
 * Capture drivers for the surfaces the `common` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { BASE_URL, DEV_PROJECT, type SurfaceDrivers } from "./shared"

export const common: SurfaceDrivers = {
  "cell-editor": async (page: Page) => {
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
  "confirm-dialog": async (page: Page) => {
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
  "project-settings": async (page: Page) => {
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/settings`)
    await page.getByRole("heading").first().waitFor({ timeout: 30_000 })
  },
}
