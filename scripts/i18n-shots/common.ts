/**
 * Capture drivers for the surfaces the `common` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { openShotsFile } from "./open-file"
import { FIRST_TARGET_TEXT } from "./seed"
import { BASE_URL, DEV_PROJECT, type SurfaceDrivers } from "./shared"

export const common: SurfaceDrivers = {
  "cell-editor": async (page: Page) => {
    // One cell open for editing — this surface's keys are the inline controls
    // and status text that sit *next to* translation content, so the shot has
    // to show a focused row with its action rail, not just the table.
    //
    // The previous driver waited on the "Import a file" CTA of the empty
    // state, which `/editor` (no file id) never renders: it lands on
    // CellAreaPlaceholder's no-file-selected branch instead. Content is now
    // seeded server-side and deep-linked — see open-file.ts.
    await openShotsFile(page)
    // Clicking the row wrapper only selects it; clicking the *target* text is
    // what mounts the TipTap editor and reveals the rail.
    await page.getByText(FIRST_TARGET_TEXT, { exact: false }).first().click()
    await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 15_000 })
    // Let the focus ring and the action rail finish transitioning in.
    await page.waitForTimeout(800)
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
