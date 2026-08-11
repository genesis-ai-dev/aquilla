/**
 * Capture drivers for the surfaces the `nav` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { BASE_URL, DEV_ORG_ID, type SurfaceDrivers } from "./shared"

export const nav: SurfaceDrivers = {
  "workspace-nav": async (page: Page) => {
    // The seeded org's project list: sidebar + top chrome + project cards.
    await page.goto(`${BASE_URL}/orgs/${DEV_ORG_ID}`)
    await page.getByRole("button", { name: /new project/i }).first().waitFor({ timeout: 30_000 })
  },
}
