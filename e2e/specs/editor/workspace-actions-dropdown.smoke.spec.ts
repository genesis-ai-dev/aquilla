import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace actions in the ⋯ overflow menu.
 *
 * AQU-661: the dynamic primary-action split button was removed; the workspace
 * actions now lead the header ⋯ overflow menu (button aria-label "More").
 *
 * With a file open and untranslated cells the menu should list the available
 * actions — "Export" and "Run AI completions" among them.
 *
 * This spec verifies the menu opens, lists multiple actions, and closes
 * without triggering any action.
 */
test("workspace actions dropdown lists available actions", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Actions ${Date.now()}` })
  await openSeededProject(alice, seeded)

  const moreBtn = alice.getByRole("banner").getByRole("button", { name: /^More$/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  const menu = alice.getByRole("menu")
  await expect(menu).toBeVisible({ timeout: 3_000 })

  await expect(menu.getByRole("menuitem", { name: /^Export$/i })).toBeVisible({ timeout: 3_000 })
  await expect(
    menu.getByRole("menuitem", { name: /Run AI completions/i })
  ).toBeVisible({ timeout: 3_000 })

  await alice.keyboard.press("Escape")
  await expect(menu).not.toBeVisible({ timeout: 3_000 })
})
