import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Project setup checklist (SetupChecklistDrawer).
 *
 * A fresh project has 3 setup items (AI instructions, collaborators, AI models).
 * A chip "Setup: 0/3" appears in the workspace header. Clicking it opens a
 * Sheet with SheetTitle "Project setup" and a progress bar.
 *
 * This spec verifies the chip renders and the drawer opens.
 */
test("setup checklist chip opens drawer with Project setup title", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Checklist ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The "Setup: 0/N" chip appears in the workspace header.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  // SetupChecklistDrawer opens as a Sheet.
  // SheetTitle is "Project setup".
  await expect(
    alice.getByRole("heading", { name: /Project setup/i })
  ).toBeVisible({ timeout: 5_000 })

  // Progress description: "X of N complete"
  await expect(
    alice.getByText(/of \d+ complete/i)
  ).toBeVisible({ timeout: 3_000 })

  // Close with Escape.
  await alice.keyboard.press("Escape")
  await expect(
    alice.getByRole("heading", { name: /Project setup/i })
  ).not.toBeVisible({ timeout: 3_000 })
})
