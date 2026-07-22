import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * File delete via context menu — ConfirmActionDialog (AQU-272 soft delete).
 *
 * FileRow right-click → FileActionMenu "Delete" → ConfirmActionDialog opens
 * with:
 *   - Title: "Move file to Recently deleted"
 *   - Description: 'Move "<filename>" to Recently deleted? ...'
 *   - Checkbox: "I understand this action." (ConfirmActionDialog default)
 *   - Cancel button (closes without deleting)
 *   - "Move to Recently deleted" button (disabled until checkbox checked)
 *
 * This spec verifies the dialog appears and Cancel dismisses without deleting.
 */
test("file delete dialog opens with acknowledgement checkbox", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Delete ${Date.now()}` })
  await openSeededProject(alice, seeded)

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
    dialog.getByText(/Move ".*" to Recently deleted\?/i)
  ).toBeVisible({ timeout: 3_000 })

  // Checkbox with acknowledgement label (shadcn Checkbox — role="checkbox";
  // the native input is hidden and no longer actionable, so target the
  // named role).
  const checkbox = dialog.getByRole("checkbox", { name: /I understand this action/i })
  await expect(checkbox).toBeVisible()
  await expect(checkbox).not.toBeChecked()
  await expect(dialog.getByText(/I understand this action/i)).toBeVisible()

  // "Move to Recently deleted" confirm button is disabled until checkbox is checked.
  const confirmBtn = dialog.getByRole("button", { name: /^Move to Recently deleted$/i })
  await expect(confirmBtn).toBeDisabled()

  // Cancel closes without deleting.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })

  // File is still in the sidebar.
  await expect(alice.locator("aside").getByText("sample").first()).toBeVisible({ timeout: 3_000 })
})
