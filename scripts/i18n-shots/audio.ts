/**
 * Capture drivers for the surfaces the `audio` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { openShotsFile } from "./open-file"
import type { SurfaceDrivers } from "./shared"

export const audio: SurfaceDrivers = {
  "audio-studio": async (page: Page) => {
    // Open the seeded file FIRST, then switch to the Audio lens with the
    // header's Text/Audio toggle. The `/voice` deep link also lands in the
    // Audio lens, but with no file open, so the centre of the shot was the
    // "No file selected" placeholder rather than the per-line record/generate
    // rows this surface's notes describe — only the Voices sidebar and the
    // transport bar had any content.
    await openShotsFile(page)
    // EditorModeToggle is a Radix Tabs list, so the lens switch is role="tab",
    // not a button (see src/components/EditorModeToggle.tsx). Its label is
    // "Audio" for a sequence-ordered file and "Media" for a time-ordered one.
    await page.getByRole("tab", { name: /^(Audio|Media)$/ }).first().click()
    await page.getByRole("heading", { name: "Voices" }).waitFor({ timeout: 30_000 })
    // The audio rows re-render per cell with their own controls; give the lens
    // switch a beat to finish before the shot.
    await page.waitForTimeout(1500)
  },
}
