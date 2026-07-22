import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Toggle validation on the StatusPie trigger — click adds yours, click again removes it.
 * Validator list is hover-only; no trash control in the popover.
 */
test("cell validation button toggles the current user's validation", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Unvalidate ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)
  await ws.editCell(0, "Translation to validate then remove")
  await ws.validateCell(0)

  const row = ws.cellRow(0)
  await row.hover()
  const healthBtn = row.getByRole("button", { name: /Validated/i }).first()
  await expect(healthBtn).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 })

  await healthBtn.click()

  await expect(healthBtn).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 })
})
