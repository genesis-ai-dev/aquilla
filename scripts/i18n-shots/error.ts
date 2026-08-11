/**
 * Capture drivers for the surfaces the `error` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { BASE_URL, type SurfaceDrivers } from "./shared"

export const error: SurfaceDrivers = {
  "error-state": async (page: Page) => {
    // A project id that cannot exist renders the workspace failure surface.
    await page.goto(`${BASE_URL}/project/i18n-shots-no-such-project/editor`)
    await page
      .getByText(/went wrong|not found|no longer have access|couldn.t|failed|error/i)
      .first()
      .waitFor({ timeout: 30_000 })
  },
}
