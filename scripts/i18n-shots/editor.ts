/**
 * Capture drivers for the surfaces the `editor` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { openShotsFile } from "./open-file"
import type { SurfaceDrivers } from "./shared"

export const editor: SurfaceDrivers = {
  "editor-table": async (page: Page) => {
    // The seeded project's editor: the source/target table with its action
    // rail, deep-linked to the seeded file so the rows are actually there.
    // `/editor` with no file id renders the no-file-selected placeholder
    // instead — see open-file.ts for why.
    await openShotsFile(page)
  },
}
