import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Next unfinished — lives in the workspace header ⋯ overflow menu (AQU-331).
 */
test("Next unfinished menu item navigates without error", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `NextUnfinished ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.openHeaderOverflowMenu()
  const item = alice.getByRole("menuitem", { name: /Next unfinished/i })
  await expect(item).toBeVisible({ timeout: 3_000 })
  await expect(item).toBeEnabled({ timeout: 3_000 })

  await item.click()
  await ws.waitForEditor()

  await ws.jumpNextUnfinished()
  await ws.waitForEditor()
})
