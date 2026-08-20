/**
 * Capture drivers for the surfaces the `dialog` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { openShotsFile } from "./open-file"
import type { SurfaceDrivers } from "./shared"

export const dialog: SurfaceDrivers = {
  "assign-modal": async (page: Page) => {
    // AssignModal's trigger lives on the file-options menu, which only renders
    // once a file is open. The previous driver tried to reach that state by
    // importing through the empty state's "Import a file" CTA, which `/editor`
    // never renders — content is seeded server-side now (see open-file.ts).
    await openShotsFile(page)
    await page.getByTestId("file-options-menu").click()
    const assignItem = page.getByRole("menuitem", { name: /assign work/i })
    await assignItem.waitFor({ timeout: 10_000 })
    await assignItem.click()
    await page.getByRole("heading", { name: /assign work/i }).waitFor({ timeout: 10_000 })
    // The assignee picker fetches project members; wait so the shot shows the
    // populated control instead of its loading state.
    await page.waitForTimeout(1500)
  },
}
