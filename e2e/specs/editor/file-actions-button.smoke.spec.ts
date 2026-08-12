import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * FileRow — "File actions" button opens the file context menu.
 *
 * FileRow.tsx has a MoreHorizontal (⋯) button with aria-label="File actions"
 * that appears on hover inside the sidebar file list. Clicking it dispatches
 * a contextmenu event so the shadcn ContextMenu opens at the pointer.
 *
 * The context menu contains items like "Rename", "Move", "Delete".
 *
 * This spec: import a file → hover the file row → click "File actions" →
 * verify the context menu contains "Rename" and "Delete" items.
 */
test("file actions button opens context menu with Rename and Delete", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FileActions ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Wait for the file row to appear in the sidebar.
  const fileRow = alice.locator("aside").getByText(/sample/i).first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })

  // Hover over the file row to reveal the "File actions" button.
  await fileRow.hover()

  // Click the "File actions" (MoreHorizontal) button.
  const fileActionsBtn = alice.locator('[aria-label="File actions"]')
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })
  await fileActionsBtn.click()

  // The context menu popup should appear with Rename and Delete items.
  const renameItem = alice.getByRole("button", { name: /^Rename$/i })
    .or(alice.getByRole("menuitem", { name: /Rename/i }))
  await expect(renameItem).toBeVisible({ timeout: 5_000 })

  const deleteItem = alice.getByRole("button", { name: /^Delete$/i })
    .or(alice.getByRole("menuitem", { name: /Delete/i }))
  await expect(deleteItem).toBeVisible({ timeout: 3_000 })

  // Press Escape to dismiss the menu.
  await alice.keyboard.press("Escape")
  await expect(renameItem).not.toBeVisible({ timeout: 3_000 })
})

/**
 * "File details" menu item opens the FileDetailsModal: metadata (type,
 * segment count) plus permission-aware actions. Alice owns the seeded
 * project, so Rename/Move/Delete are enabled; the seeded file is sample.md,
 * so source export is disabled with the USFM-only reason.
 */
test("file details menu item opens metadata modal with permission-aware actions", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FileDetails ${Date.now()}` })
  await openSeededProject(alice, seeded)

  const fileRow = alice.locator("aside").getByText(/sample/i).first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.hover()
  const fileActionsBtn = alice.locator('[aria-label="File actions"]')
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })
  await fileActionsBtn.click()

  await alice.getByRole("menuitem", { name: /File details/i }).click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /sample\.md/i })).toBeVisible()
  await expect(dialog.getByText("MD", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Segments")).toBeVisible()

  // Owner role: Rename/Move/Delete enabled; MD file: export disabled with reason.
  await expect(dialog.getByRole("button", { name: /^Rename$/ })).toBeEnabled()
  await expect(dialog.getByRole("button", { name: /^Delete$/ })).toBeEnabled()
  await expect(dialog.getByRole("button", { name: /Export source/ })).toBeDisabled()
  await expect(dialog.getByText(/Only USFM files support/i)).toBeVisible()

  // Delete chains into the existing soft-delete confirmation dialog.
  await dialog.getByRole("button", { name: /^Delete$/ }).click()
  await expect(alice.getByRole("heading", { name: /Recently deleted/i })).toBeVisible({ timeout: 5_000 })
  await alice.getByRole("button", { name: /Cancel/i }).click()
})
