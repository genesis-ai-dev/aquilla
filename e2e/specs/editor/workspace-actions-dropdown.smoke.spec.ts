import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace file actions in the chapter-row File options ⋯ menu.
 *
 * With a file open and untranslated cells the menu should list the available
 * actions — "Export" and "Run AI completions" among them.
 *
 * This spec verifies the menu opens, lists multiple actions, and closes
 * without triggering any action.
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

  await alice.keyboard.press("Escape")
  await expect(menu).not.toBeVisible({ timeout: 3_000 })
})
