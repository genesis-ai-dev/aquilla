import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ExportDialog — scope toggle (file vs project).
 *
 * ExportDialog uses SegmentTabs (aria-label="Export scope") with tabs
 * "Current file" (default) and "Whole project". Selection is reflected via
 * aria-selected on each tab. Scope lives inside the "Export to another
 * format" section (the primary download is always current-file).
 *
 * This spec: open the export dialog → expand the formats section → verify
 * "Current file" is selected → click "Whole project" → verify it becomes
 * selected.
 */
test("export dialog scope toggle switches between file and project", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ExportScope ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Open the export dialog from the header overflow menu (AQU-331).
  await ws.openExportDialog()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await ws.openExportFormatsSection()

  const fileTab = dialog.getByRole("tab", { name: "Current file" })
  await expect(fileTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })

  const projectTab = dialog.getByRole("tab", { name: "Whole project" })
  await projectTab.click()

  await expect(projectTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
  await expect(fileTab).toHaveAttribute("aria-selected", "false")

  // Dismiss.
  await alice.keyboard.press("Escape")
})
