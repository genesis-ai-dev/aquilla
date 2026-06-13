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
 * options rendered as Base UI radios (role=radio) inside labels reading
 * "Current file" (default) and "Whole project". The radio element itself
 * is sr-only — interaction goes through the label text.
 *
 * This spec: open the export dialog → verify "Current file" is checked →
 * click the "Whole project" label → verify it becomes checked.
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

  // "Current file" radio is checked by default (Base UI: role=radio, sr-only).
  const fileRadio = dialog.getByRole("radio", { name: "Current file" })
  await expect(fileRadio).toBeChecked({ timeout: 3_000 })

  // Click the "Whole project" label to switch scope (the radio is sr-only,
  // so the visible label is the click target).
  const projectRadio = dialog.getByRole("radio", { name: "Whole project" })
  await dialog.getByText("Whole project").click()

  // "Whole project" radio is now checked.
  await expect(projectRadio).toBeChecked({ timeout: 2_000 })
  await expect(fileRadio).not.toBeChecked()

  // Dismiss.
  await alice.keyboard.press("Escape")
})
