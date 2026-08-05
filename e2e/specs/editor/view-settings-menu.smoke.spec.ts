import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ViewSettingsMenu — opened from the workspace header ⋯ overflow (AQU-331).
 *
 * Popover contains toggleable items:
 *   - "Show line numbers" (Switch)
 *   - "Show cell labels" (Switch)
 *   - Text direction: Source and Target (DirPill)
 */
test("view settings menu opens and toggles show line numbers", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ViewSettings ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  await ws.openViewSettingsMenu()

  const panel = alice.getByTestId("view-settings-popover")
  const lineNumbers = panel.getByRole("switch", { name: /Show line numbers/i })
  await expect(lineNumbers).toBeVisible({ timeout: 3_000 })
  await expect(panel.getByRole("switch", { name: /Show cell labels/i })).toBeVisible({ timeout: 3_000 })

  const wasChecked = await lineNumbers.isChecked()
  await lineNumbers.click()
  await expect(lineNumbers).toHaveAttribute("aria-checked", wasChecked ? "false" : "true")
})
