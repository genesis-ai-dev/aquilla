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
