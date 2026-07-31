import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * File rename — Escape key cancels without saving.
 *
 * FileRow.tsx inline rename input has a keyDown handler:
 *   Enter → onEditCommit(draft)  (saves the new name)
 *   Escape → onEditCancel()      (discards the draft, restores original name)
 *
 * This spec tests the Escape path — distinct from the Enter commit tested in
 * file-rename.smoke.spec.ts. It verifies the original filename is preserved.
 *
 * This spec:
 *   1. Imports sample.md.
 *   2. Right-clicks the sidebar file row → clicks "Rename".
 *   3. Clears the inline input and types a new draft name.
 *   4. Presses Escape — rename is cancelled.
 *   5. Verifies the original name "sample" is still shown in the sidebar.
 */
test("Escape in file rename input cancels without changing the filename", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RenameCancel ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Right-click the file row to open the context menu.
  const sidebar = alice.locator("aside")
  const fileRow = sidebar.getByText("sample").first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.click({ button: "right" })

  // Click "Rename" (shadcn ContextMenu — role="menuitem").
  const renameItem = alice.getByRole("menuitem", { name: /^Rename$/i })
  await expect(renameItem).toBeVisible({ timeout: 3_000 })
  await renameItem.click()

  // Inline input appears — type a draft name. The sidebar's filter input
  // is a role=searchbox, so role=textbox uniquely matches the rename input.
  const inlineInput = sidebar.getByRole("textbox")
  await expect(inlineInput).toBeVisible({ timeout: 3_000 })
  await inlineInput.selectText()
  await inlineInput.fill("should-not-be-saved")

  // Press Escape — cancels the rename.
  await inlineInput.press("Escape")

  // The inline input should be gone (cancel closed the edit mode).
  await expect(inlineInput).not.toBeVisible({ timeout: 3_000 })

  // The original filename "sample" is still shown in the sidebar.
  await expect(sidebar.getByText("sample").first()).toBeVisible({ timeout: 3_000 })

  // The draft name should NOT appear.
  await expect(sidebar.getByText("should-not-be-saved")).not.toBeVisible({ timeout: 1_000 })
})
