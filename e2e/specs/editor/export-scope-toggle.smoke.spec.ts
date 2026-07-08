import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ExportDialog — scope toggle (file vs project).
 *
 * ExportDialog uses SegmentTabs (aria-label="Export scope") with tabs
 * "Current file" (default) and "Whole project". Selection is reflected via
 * aria-selected on each tab.
 *
 * This spec: open the export dialog → verify "Current file" is selected →
 * click "Whole project" → verify it becomes selected.
 */
test("export dialog scope toggle switches between file and project", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ExportScope ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the export dialog from the header overflow menu (FRO-331).
  await ws.openExportDialog()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const fileTab = dialog.getByRole("tab", { name: "Current file" })
  await expect(fileTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })

  const projectTab = dialog.getByRole("tab", { name: "Whole project" })
  await projectTab.click()

  await expect(projectTab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 })
  await expect(fileTab).toHaveAttribute("aria-selected", "false")

  // Dismiss.
  await alice.keyboard.press("Escape")
})
