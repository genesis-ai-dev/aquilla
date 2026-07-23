import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * PrimaryActionButton "More actions" dropdown.
 *
 * The workspace header has a split button: the left part runs the default
 * action, the right chevron opens a dropdown listing all available actions.
 *
 * With a file open and untranslated cells:
 *   - "Run AI completions" is the default action (translated < total)
 *   - The dropdown should include all primary actions available for the file:
 *     "Export", "Batch validate…", and potentially others
 *
 * This spec verifies the dropdown opens, lists multiple actions, and closes
 * without triggering any action.
 */
test("workspace actions dropdown lists available actions", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Actions ${Date.now()}` })
  await openSeededProject(alice, seeded)

  const moreBtn = alice.getByRole("button", { name: /More actions/i })
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
