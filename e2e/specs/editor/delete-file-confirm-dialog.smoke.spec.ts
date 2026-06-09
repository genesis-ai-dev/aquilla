import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ProjectWorkspace — "Delete file" ConfirmActionDialog.
 *
 * ProjectWorkspace.tsx line 2536-2547:
 *   <ConfirmActionDialog
 *     open={pendingDeleteId !== null}
 *     title="Delete file"
 *     description={`Remove "${f.name}" from this project? ...`}
 *     confirmLabel="Delete"
 *     checkboxLabel="I understand this removes the file from the project."
 *     onConfirm={...}
 *   />
 *
 * This dialog opens when the user selects "Delete" from the file action menu.
 * The confirm button is disabled until the checkbox is checked.
 *
 * Flow:
 *   1. Import a file → hover file row → click "File actions" → click "Delete".
 *   2. ConfirmActionDialog opens with title "Delete file".
 *   3. The confirm "Delete" button is initially disabled.
 *   4. Check the confirmation checkbox → confirm button enables.
 *   5. Click confirm → file is removed from the sidebar.
 */
test("Delete file confirm dialog requires checkbox before confirming", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `DeleteFile ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Hover the file row and open the file actions menu.
  const fileRow = alice.locator("aside").getByText(/sample/i).first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.hover()

  const fileActionsBtn = alice.locator('[aria-label="File actions"]')
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })
  await fileActionsBtn.click()

  // Click "Delete" in the context menu.
  const deleteItem = alice.getByRole("button", { name: /^Delete$/i })
    .or(alice.getByRole("menuitem", { name: /Delete/i }))
  await expect(deleteItem).toBeVisible({ timeout: 5_000 })
  await deleteItem.click()

  // ConfirmActionDialog should open with title "Delete file".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText(/Delete file/i)).toBeVisible({ timeout: 3_000 })

  // The confirm "Delete" button is initially disabled (checkbox not checked).
  const confirmBtn = dialog.getByRole("button", { name: /^Delete$/i })
  await expect(confirmBtn).toBeDisabled()

  // Check the confirmation checkbox.
  const checkbox = dialog.locator('input[type="checkbox"]')
    .or(dialog.locator('[role="checkbox"]'))
  await expect(checkbox).toBeVisible({ timeout: 3_000 })
  await checkbox.click()

  // Confirm button should now be enabled.
  await expect(confirmBtn).toBeEnabled({ timeout: 3_000 })

  // Click confirm — file should be removed.
  await confirmBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // The file row should no longer appear in the sidebar.
  await expect(alice.locator("aside").getByText(/sample/i)).not.toBeVisible({ timeout: 5_000 })
})
