import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_USFM = path.resolve(__dirname, "../../fixtures/sample.usfm")

/**
 * FileSectionGrid — clicking a section row navigates into the editor.
 *
 * The old ProgressDot grid was replaced by FileSectionGrid
 * (src/components/sidebar/FileSectionGrid.tsx): one clickable row per
 * section, each a <button> whose accessible name is the section label and
 * whose title is "<label> — N% translated, M% validated". Clicking a row
 * calls onSectionClick → onSelectFile (opens the file at /project/:id/file/
 * :fileId) + requestScrollToSection.
 *
 * Sections exist only for scripture file types (fileTypeHasSections is
 * usfm/ebible-only), so this spec imports sample.usfm — two chapters become
 * sections "GEN 1" and "GEN 2".
 *
 * This spec:
 *   1. Imports sample.usfm.
 *   2. Expands the file row in the sidebar (aria-label "Expand" chevron).
 *   3. Clicks the first section row ("GEN 1").
 *   4. Verifies the editor is open (cells visible).
 *   5. Verifies the URL now contains the /file/ segment (file is loaded).
 */
test("clicking a sidebar section row opens the editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ProgDot ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_USFM)

  const sidebar = alice.locator("aside")

  // Wait for the file row to appear.
  await expect(sidebar.getByText("sample").first()).toBeVisible({ timeout: 10_000 })

  // Expand the file row — the chevron has aria-label "Expand" (FileRow.tsx;
  // the row root is a div[tabindex="0"], not an li).
  const chevron = sidebar.locator('[aria-label="Expand"]').first()
  await expect(chevron).toBeVisible({ timeout: 5_000 })
  await chevron.click()

  // Section rows render in the FileSectionGrid with the section label as
  // their accessible name and a "% translated, % validated" title.
  const sectionRow = sidebar.getByRole("button", { name: /^GEN 1$/ })
  await expect(sectionRow).toBeVisible({ timeout: 10_000 })

  // Click the section row.
  await sectionRow.click()

  // After navigation the editor should be open.
  await ws.waitForEditor()

  // URL should now reference the file (contains /file/ segment).
  await expect(alice).toHaveURL(/\/file\//, { timeout: 5_000 })
})
