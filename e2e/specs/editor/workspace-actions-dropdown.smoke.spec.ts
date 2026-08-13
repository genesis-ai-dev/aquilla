import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace file actions in the chapter-row File options ⋯ menu.
 *
 * With a file open the menu lists workspace actions (e.g. Run AI completions)
 * and file actions together: Rename, Move, Assign work, then Export.
 *
 * This spec verifies the menu opens, lists those items in that file-action
 * order, and closes without triggering any action.
 */
test("workspace actions dropdown lists available actions", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Actions ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.openFileOverflowMenu()

  const menu = alice.getByRole("menu")
  await expect(menu).toBeVisible({ timeout: 3_000 })

  await expect(menu.getByRole("menuitem", { name: /^Export$/i })).toBeVisible({ timeout: 3_000 })
  await expect(
    menu.getByRole("menuitem", { name: /Run AI completions/i })
  ).toBeVisible({ timeout: 3_000 })
  await expect(menu.getByRole("menuitem", { name: /^Rename$/i })).toBeVisible({ timeout: 3_000 })
  await expect(menu.getByRole("menuitem", { name: /Move to corpus/i })).toBeVisible({ timeout: 3_000 })
  await expect(menu.getByRole("menuitem", { name: /Assign work/i })).toBeVisible({ timeout: 3_000 })

  const renameBox = await menu.getByRole("menuitem", { name: /^Rename$/i }).boundingBox()
  const assignBox = await menu.getByRole("menuitem", { name: /Assign work/i }).boundingBox()
  const exportBox = await menu.getByRole("menuitem", { name: /^Export$/i }).boundingBox()
  expect(renameBox).not.toBeNull()
  expect(assignBox).not.toBeNull()
  expect(exportBox).not.toBeNull()
  expect(assignBox!.y).toBeGreaterThan(renameBox!.y)
  expect(exportBox!.y).toBeGreaterThan(assignBox!.y)

  await alice.keyboard.press("Escape")
  await expect(menu).not.toBeVisible({ timeout: 3_000 })
})
