/**
 * Capture drivers for the surfaces the `auth` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 *
 * The `auth` surface is PRE-authentication (the sign-in screen itself), so
 * unlike other namespaces' drivers this one must NOT use the `/__dev/login`
 * bypass — that would sign the capture browser in and never show the form.
 */

import type { Page } from "@playwright/test"
import { BASE_URL, type SurfaceDrivers } from "./shared"

export const auth: SurfaceDrivers = {
  auth: async (page: Page) => {
    // Sign-in form, reached directly with no session and no dev-login bypass.
    await page.goto(`${BASE_URL}/login`)
    await page.getByLabel(/username or email/i).waitFor({ timeout: 30_000 })
  },
}
