import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Toggle validation on the HealthRing trigger — click adds yours; removing yours
 * uses the validators popover ("Remove your validation").
 */
test("cell validation button toggles the current user's validation", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Unvalidate ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)
  await ws.editCell(0, "Translation to validate then remove")
  await ws.validateCell(0)
  await ws.unvalidateCell(0)

  await expect(ws.validationToggle(0)).toHaveAttribute("aria-pressed", "false")
})
