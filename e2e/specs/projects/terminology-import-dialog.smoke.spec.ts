import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology Import dialog (TermbaseImportDialog).
 *
 * The terminology page header has an "Import" button that opens TermbaseImportDialog with:
 *   - DialogTitle "Import term base"
 *   - Format tab strip: "csv" and "tbx" buttons
 *   - Drop zone for file upload
 *
 * This spec verifies the dialog opens, both format tabs are present, and
 * switching tabs works. No file is uploaded.
 */
test("terminology import dialog opens with CSV and TBX format tabs", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermImport ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // The termbase "Import" button lives in the terminology page BODY (main),
  // next to "Add concept". The workspace shell's banner has its own file
  // "Import" button which opens the file ImportDialog — scoping to banner
  // opens the wrong dialog.
  const importBtn = alice.getByRole("main").getByRole("button", { name: /^Import$/i })
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await importBtn.click()

  // TermbaseImportDialog opens — DialogTitle is "Import term base".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Import term ?base/i })).toBeVisible()

  // Both format tabs are present. Anchored names: the drop zone also has a
  // "Choose CSV file" / "Choose TBX file" button that would otherwise match.
  const csvTab = dialog.getByRole("button", { name: /^csv$/i })
  const tbxTab = dialog.getByRole("button", { name: /^tbx$/i })
  await expect(csvTab).toBeVisible({ timeout: 3_000 })
  await expect(tbxTab).toBeVisible({ timeout: 3_000 })

  // Switch to TBX tab.
  await tbxTab.click()

  // Switch back to CSV.
  await csvTab.click()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
