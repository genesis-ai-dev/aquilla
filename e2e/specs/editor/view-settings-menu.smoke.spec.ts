import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ViewSettingsMenu — opened from the workspace header ⋯ overflow (AQU-331).
 *
 * Menu contains toggleable items:
 *   - "Show line numbers" (Pill toggle)
 *   - "Show cell labels" (Pill toggle)
 *   - Text direction: Source and Target (DirPill)
 */
test("view settings menu opens and toggles show line numbers", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ViewSettings ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.openViewSettingsMenu()

  const lineNumbersItem = alice.getByText(/Show line numbers/i).first()
  await expect(lineNumbersItem).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByText(/Show cell labels/i).first()).toBeVisible({ timeout: 3_000 })

  await lineNumbersItem.click()
  await expect(lineNumbersItem).not.toBeVisible({ timeout: 3_000 })
})
