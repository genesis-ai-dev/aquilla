/**
 * "Editor open on the seeded file" — the shared precondition for every surface
 * that needs translation content on screen (AQU-511).
 *
 * WHY A DEEP LINK. `/project/:id/editor` with no file in the URL renders
 * `CellAreaPlaceholder`'s *no-file-selected* branch ("No file selected — Pick a
 * file from the sidebar to start translating"), which by that component's own
 * design shows neither cells nor the "No files yet — Import a file" CTA. The
 * previous drivers waited on that CTA, so they timed out on a project that has
 * files: the affordance simply never renders in that state. `/editor/file/:id`
 * is the route the file sidebar itself navigates to, so it is the real path to
 * a populated editor — same approach as `openSeededProject` in
 * `e2e/helpers/seed-project.ts`.
 */

import type { Page } from "@playwright/test"
import { SHOTS_FILE_ID } from "./seed"
import { BASE_URL, DEV_PROJECT } from "./shared"

/** Each row wrapper in EditorTable carries `data-grid-row`. */
export const CELL_ROW = "[data-grid-row]"

/**
 * Navigate to the seeded file's editor and settle on a real rendered row.
 *
 * Settling on a row rather than the shell matters: cells stream in over HTTP,
 * and a shot taken before they land is a mostly-blank frame that looks like a
 * successful capture.
 */
export async function openShotsFile(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/project/${DEV_PROJECT}/editor/file/${SHOTS_FILE_ID}`)
  await page.locator(CELL_ROW).first().waitFor({ timeout: 60_000 })
  // The first-open translation-direction prompt is its own dialog, not any of
  // the surfaces under capture — dismiss it if the project has never set one.
  const skipDirection = page.getByRole("button", { name: /skip for now/i })
  if (await skipDirection.isVisible().catch(() => false)) {
    await skipDirection.click()
    await skipDirection.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {})
  }
}
