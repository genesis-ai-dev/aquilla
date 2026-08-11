/**
 * Capture drivers for the surfaces the `search` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { openShotsFile } from "./open-file"
import type { SurfaceDrivers } from "./shared"

export const search: SurfaceDrivers = {
  search: async (page: Page) => {
    // Content first, so the dock has something to find. The previous driver
    // tried to import through the empty state's "Import a file" CTA, which
    // `/editor` never renders — see open-file.ts.
    await openShotsFile(page)

    // Open the search dock (left dock rail icon, aria-label "Search").
    await page.getByRole("button", { name: "Search", exact: true }).first().click()

    // A query that matches the seeded source text, so the shot shows the
    // result list alongside the mode switcher and scope toggle.
    const searchBox = page.getByPlaceholder(/search/i).first()
    await searchBox.waitFor({ timeout: 15_000 })
    await searchBox.fill("God")
    // Settle on the dock's own result chrome. Waiting on matched text (as this
    // driver used to) is not enough: the same words are on screen in the
    // editor table behind the dock, so the wait resolved instantly and the
    // shot caught the panel still reading "Searching…". "Expand all" and the
    // result count only render once results have landed.
    await page.getByRole("button", { name: /expand all/i }).waitFor({ timeout: 30_000 })
    await page.getByText(/\d+ results?/).first().waitFor({ timeout: 30_000 })
  },
}
