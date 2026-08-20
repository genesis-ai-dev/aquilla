/**
 * Capture drivers for the surfaces the `nav` namespace declares (AQU-511).
 *
 * Each driver navigates to the state its surface describes, settles on an
 * observable element, and leaves the page ready for a screenshot. Driven by
 * `scripts/i18n-shots.ts`; `src/lib/i18n/context.test.ts` asserts every declared
 * surface has one here.
 */

import type { Page } from "@playwright/test"
import { openShotsFile } from "./open-file"
import type { SurfaceDrivers } from "./shared"

export const nav: SurfaceDrivers = {
  "workspace-nav": async (page: Page) => {
    // A project workspace with a file open, which is what this surface declares
    // (`route: "/project/:projectId"`) and what its keys describe: the file dock
    // and its tabs, the Comments/Terminology/More sidebar sections, the
    // back/forward page-history chevrons, the tab strip, the Beta badge, and
    // the account / help / version controls pinned to the sidebar foot.
    //
    // The previous driver went to `/orgs/<hard-coded 1>` — the org portfolio
    // page, a different screen from the declared route, and on a database where
    // "Dev Org" isn't org 1 it was some other org's page entirely.
    await openShotsFile(page)
    // The file dock must actually be expanded, or the whole left column the
    // nav keys describe is collapsed to an icon rail.
    await page.getByRole("button", { name: "Files", exact: true }).first().waitFor({ timeout: 30_000 })
    // Expand "Help & community" so the nav.help.* items (tour / docs / Discord
    // / contact support / report) are on screen too. Without this the shot is
    // frame-identical to editor-table, and half this namespace's keys — the
    // ones behind collapsed sidebar sections — appear in no screenshot at all.
    // A collapsible expands in place, so the rest of the chrome stays visible;
    // an overlay menu would hide the column it belongs to.
    const help = page.getByRole("button", { name: /help & community/i }).first()
    await help.click()
    // "Discord server" is always in this menu; nav.help.tour ("Take the tour")
    // is conditional, so it is not a safe settle target.
    await page.getByText(/discord server/i).first().waitFor({ timeout: 10_000 })
    // The popover fades in over the sidebar items it covers. Shooting on
    // first-visible caught it mid-transition, double-exposing its labels over
    // "Terminology"/"More"/"Setup" underneath — legible to nobody. Wait out
    // the transition.
    await page.waitForTimeout(1200)
  },
}
