import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * FileRow — the "File actions" (⋯) button opens the file's menu.
 *
 * The button is a real menu trigger, so it opens the same items the row's
 * right-click menu shows and anchors them to itself. It used to dispatch a
 * synthetic `contextmenu` event instead, which had no coordinates to anchor to
 * when the press came from the keyboard — the menu opened in the top-left corner
 * of the window.
 *
 * This spec: import a file → click "File actions" → verify Rename and Delete →
 * reopen it from the keyboard and verify the menu is anchored to the button.
 */
test("file actions button opens the file menu for pointer and keyboard alike", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FileActions ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Wait for the file row to appear in the sidebar.
  const fileRow = alice.locator("aside").getByText(/sample/i).first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })

  // Hover over the file row to reveal the "File actions" button.
  await fileRow.hover()

  const fileActionsBtn = alice.locator('button[aria-label="File actions"]').first()
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })
  await expect(fileActionsBtn).toHaveAttribute("aria-haspopup", "menu")

  await fileActionsBtn.click()

  const renameItem = alice.getByRole("menuitem", { name: /Rename/i })
  await expect(renameItem).toBeVisible({ timeout: 5_000 })
  await expect(alice.getByRole("menuitem", { name: /Delete/i })).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("menuitem", { name: /^Export$/ })).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("menuitem", { name: /Assign work/i })).toBeVisible({ timeout: 3_000 })
  await expect(fileActionsBtn).toHaveAttribute("aria-expanded", "true")

  // Press Escape to dismiss the menu.
  await alice.keyboard.press("Escape")
  await expect(renameItem).not.toBeVisible({ timeout: 3_000 })

  // A keyboard press carries no pointer coordinates, so this is the case the
  // synthetic right-click got wrong: the menu must still hang off the button.
  await fileActionsBtn.focus()
  await alice.keyboard.press("Enter")
  const popup = alice.locator('[data-slot="dropdown-menu-content"]')
  await expect(popup).toBeVisible({ timeout: 10_000 })
  await expect(renameItem).toBeVisible({ timeout: 5_000 })

  const buttonBox = await fileActionsBtn.boundingBox()
  const popupBox = await popup.boundingBox()
  expect(buttonBox).not.toBeNull()
  expect(popupBox).not.toBeNull()
  // Below the button and flush with its trailing edge — not in the window corner.
  expect(popupBox!.y).toBeGreaterThan(buttonBox!.y)
  expect(
    Math.abs(popupBox!.x + popupBox!.width - (buttonBox!.x + buttonBox!.width)),
  ).toBeLessThan(24)
})

/**
 * "File details" menu item opens the FileDetailsModal: metadata only
 * (type, segment count). File actions stay on the row menu, not the dialog.
 */
test("file details menu item opens metadata modal", async ({ alice }) => {
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

  await expect(dialog.getByRole("button", { name: /^Rename$/ })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: /^Delete$/ })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: /Export source/ })).toHaveCount(0)
})

/**
 * File-row menu Export and Assign work open the same dialogs as the
 * editor overflow menu, scoped to the clicked file.
 */
test("file menu Export and Assign work open their dialogs", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FileMenuDialogs ${Date.now()}` })
  await openSeededProject(alice, seeded)

  const fileRow = alice.locator("aside").getByText(/sample/i).first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  await fileRow.hover()
  const fileActionsBtn = alice.locator('button[aria-label="File actions"]').first()
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })

  await fileActionsBtn.click()
  await alice.getByRole("menuitem", { name: /^Export$/ }).click()
  const exportDialog = alice.getByRole("dialog")
  await expect(exportDialog).toBeVisible({ timeout: 5_000 })
  await expect(exportDialog.getByRole("heading", { name: "Export" })).toBeVisible()
  await alice.keyboard.press("Escape")
  await expect(exportDialog).not.toBeVisible({ timeout: 3_000 })

  await fileRow.hover()
  await expect(fileActionsBtn).toBeVisible({ timeout: 5_000 })
  await fileActionsBtn.click()
  await alice.getByRole("menuitem", { name: /Assign work/i }).click()
  const assignDialog = alice.getByRole("dialog")
  await expect(assignDialog).toBeVisible({ timeout: 5_000 })
  await expect(assignDialog.getByRole("heading", { name: /Assign work/i })).toBeVisible()
})
