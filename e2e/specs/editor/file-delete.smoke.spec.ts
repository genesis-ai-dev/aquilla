import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * File delete via context menu — ConfirmActionDialog.
 *
 * FileRow right-click → FileActionMenu "Delete" → ConfirmActionDialog opens
 * with:
 *   - Description: 'Remove "<filename>" from this project?'
 *   - Checkbox: "I understand this removes the file from the project."
 *   - Cancel button (closes without deleting)
 *   - "Delete" button (disabled until checkbox checked)
 *
 * This spec verifies the dialog appears and Cancel dismisses without deleting.
 */
test("file delete dialog opens with acknowledgement checkbox", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Delete ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Right-click the file row to open context menu.
  const fileRow = alice.locator("aside").getByText("sample").first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.click({ button: "right" })

  // Click "Delete" in the context menu (shadcn DropdownMenu — role="menuitem").
  const deleteBtn = alice.getByRole("menuitem", { name: /^Delete$/i })
  await expect(deleteBtn).toBeVisible({ timeout: 3_000 })
  await deleteBtn.click()

  // ConfirmActionDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Description contains the filename.
  await expect(
    dialog.getByText(/Remove ".*" from this project/i)
  ).toBeVisible({ timeout: 3_000 })

  // Checkbox with acknowledgement label (shadcn Checkbox — role="checkbox";
  // the native input is hidden and no longer actionable).
  const checkbox = dialog.getByRole("checkbox")
  await expect(checkbox).toBeVisible()
  await expect(checkbox).not.toBeChecked()
  await expect(
    dialog.getByText(/I understand this removes the file from the project/i)
  ).toBeVisible()

  // "Delete" confirm button is disabled until checkbox is checked.
  const confirmBtn = dialog.getByRole("button", { name: /^Delete$/i })
  await expect(confirmBtn).toBeDisabled()

  // Cancel closes without deleting.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })

  // File is still in the sidebar.
  await expect(alice.locator("aside").getByText("sample").first()).toBeVisible({ timeout: 3_000 })
})
