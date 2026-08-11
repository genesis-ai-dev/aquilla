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
    // The 404 page, reached by any unmatched route.
    //
    // WHY NOT `/project/<nonexistent>`: that route does render a failure, but
    // it is a single line of muted prose ("You no longer have access to this
    // project…") on an otherwise blank 1440x900 frame — no heading, no button,
    // nothing showing the shape this namespace's context describes ("the title
    // is a heading, not a button"). The 404 screen renders
    // error.notFound.title as a real heading, error.notFound.description under
    // it, and error.notFound.goHome as a button, so one frame shows the
    // heading/body/action layout every other key in the namespace is written
    // against. The surface's declared `route` was updated to match.
    await page.goto(`${BASE_URL}/i18n-shots-no-such-route`)
    await page.getByRole("heading", { name: /page not found/i }).waitFor({ timeout: 30_000 })
    await page.getByRole("button", { name: /go home/i }).waitFor({ timeout: 10_000 })
  },
}
