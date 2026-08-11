/**
 * Capture drivers for the surfaces the `editor` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { BASE_URL, DEV_PROJECT, type SurfaceDrivers } from "./shared"

export const editor: SurfaceDrivers = {
  "editor-table": async (page: Page) => {
    // The seeded project's editor: the source/target table with its action rail.
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/editor`)
    // Settle on a real cell row rather than the shell — the table streams its
    // cells in, and a shot taken before they land shows only the placeholder.
    // `data-grid-row` is set on each row wrapper in EditorTable; the row's
    // accessible name is the cell reference, so there is no stable text to
    // wait on.
    await page.locator("[data-grid-row]").first().waitFor({ timeout: 30_000 })
  },
}
