/**
 * Capture drivers for the surfaces the `comments` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { BASE_URL, DEV_PROJECT, type SurfaceDrivers } from "./shared"

export const comments: SurfaceDrivers = {
  comments: async (page: Page) => {
    // Full-page thread list. The seeded dev project has no comments, so this
    // settles on the empty state — the header and filter bar above it (most
    // of what this namespace's keys describe) render regardless of content.
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/comments`)
    await page.getByRole("heading", { name: /comments/i }).first().waitFor({ timeout: 30_000 })
  },
}
