/**
 * Capture drivers for the surfaces the `audio` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { BASE_URL, DEV_PROJECT, type SurfaceDrivers } from "./shared"

export const audio: SurfaceDrivers = {
  "audio-studio": async (page: Page) => {
    // The `/voice` deep link puts ProjectWorkspace straight into the Audio
    // lens on mount (see ProjectWorkspace.tsx), landing on the Voices
    // sidebar + transport bar without needing to click through tabs.
    //
    // The full recording flow (AudioRecordingModal) needs live microphone
    // permission, which a headless capture browser cannot grant — so this
    // driver stops at the Voices sidebar + playback bar, the reachable state
    // that still shows the bulk of this namespace's strings (voice rows,
    // narrator badge, New voice button, transport controls).
    await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/voice`)
    await page.getByRole("heading", { name: "Voices" }).waitFor({ timeout: 30_000 })
  },
}
