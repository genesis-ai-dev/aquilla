import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectWorkspace — soft-delete ConfirmActionDialog (AQU-272).
 *
 * ProjectWorkspace.tsx (~line 3622):
 *   <ConfirmActionDialog
 *     open={pendingDeleteId !== null}
 *     title="Move file to Recently deleted"
 *     description={`Move "${f.name}" to Recently deleted? ...`}
 *     confirmLabel="Move to Recently deleted"
 *     onConfirm={...}
 *   />
 *
 * The checkbox uses ConfirmActionDialog's default label
 * "I understand this action." and the confirm button is disabled until
 * the checkbox is checked.
 *
 * Flow:
 *   1. Import a file → hover file row → click "File actions" → click "Delete".
 *   2. ConfirmActionDialog opens with title "Move file to Recently deleted".
 *   3. The confirm "Move to Recently deleted" button is initially disabled.
 *   4. Check the confirmation checkbox → confirm button enables.
 *   5. Click confirm → file is removed from the sidebar (soft-deleted).
 */
test("Delete file confirm dialog requires checkbox before confirming", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `DeleteFile ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Hover the file row and open the file actions menu.
  const fileRow = alice.locator("aside").getByText(/sample/i).first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.hover()

  const fileActionsBtn = alice.locator('[aria-label="File actions"]')
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })
  await fileActionsBtn.click()

  // Click "Delete" in the context menu (shadcn ContextMenu — role="menuitem").
  const deleteItem = alice.getByRole("menuitem", { name: /^Delete$/i })
  await expect(deleteItem).toBeVisible({ timeout: 5_000 })
  await deleteItem.click()

  // ConfirmActionDialog should open with title "Move file to Recently deleted".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(
    dialog.getByRole("heading", { name: /Move file to Recently deleted/i })
  ).toBeVisible({ timeout: 3_000 })

  // The confirm button is initially disabled (checkbox not checked).
  const confirmBtn = dialog.getByRole("button", { name: /^Move to Recently deleted$/i })
  await expect(confirmBtn).toBeDisabled()

  // Check the confirmation checkbox (shadcn Checkbox — role="checkbox";
  // the hidden native input also remains in the DOM, so target the named role).
  const checkbox = dialog.getByRole("checkbox", { name: /I understand this action/i })
  await expect(checkbox).toBeVisible({ timeout: 3_000 })
  await checkbox.check()

  // Confirm button should now be enabled.
  await expect(confirmBtn).toBeEnabled({ timeout: 3_000 })

  // Click confirm — file should be removed.
  await confirmBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // The file row should no longer appear in the sidebar.
  await expect(alice.locator("aside").getByText(/sample/i)).not.toBeVisible({ timeout: 5_000 })
})
