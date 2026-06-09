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
 * ExportDialog has a radiogroup (aria-label="Export scope") with two
 * options: "file" (default) and "project". Each is a radio input.
 *
 * This spec: open the export dialog → verify "file" radio is checked →
 * click the "project" label → verify "project" radio becomes checked.
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

  // Open the export dialog.
  const exportBtn = alice.getByRole("button", { name: /^Export$/i }).first()
  await expect(exportBtn).toBeVisible({ timeout: 5_000 })
  await exportBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // "file" radio is checked by default.
  const fileRadio = dialog.locator('input[type="radio"][name="export-scope"][value="file"]')
  await expect(fileRadio).toBeChecked({ timeout: 3_000 })

  // Click the "project" label to switch scope.
  const projectRadio = dialog.locator('input[type="radio"][name="export-scope"][value="project"]')
  await expect(projectRadio).toBeVisible({ timeout: 3_000 })
  await projectRadio.check({ force: true })

  // "project" radio is now checked.
  await expect(projectRadio).toBeChecked({ timeout: 2_000 })
  await expect(fileRadio).not.toBeChecked()

  // Dismiss.
  await alice.keyboard.press("Escape")
})
