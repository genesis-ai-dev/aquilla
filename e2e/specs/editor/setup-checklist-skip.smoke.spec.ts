import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SetupChecklistDrawer — "Skip for now" button closes the drawer.
 *
 * SetupChecklistDrawer.tsx renders a Sheet (drawer) with:
 *   - SheetTitle "Project setup"
 *   - Setup items
 *   - "Skip for now" button (when not all items are complete)
 *
 * Clicking "Skip for now" calls onDismiss(), which closes the Sheet.
 *
 * This spec: open the setup checklist → click "Skip for now" →
 * verify the drawer closes (heading disappears).
 */
test("setup checklist Skip for now closes the drawer", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ChecklistSkip ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Open the setup checklist chip.
  const chip = alice.getByRole("button", { name: /Setup:/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  // Drawer opens with "Project setup" heading.
  const heading = alice.getByRole("heading", { name: /Project setup/i })
  await expect(heading).toBeVisible({ timeout: 5_000 })

  // Click "Skip for now".
  const skipBtn = alice.getByRole("button", { name: /Skip for now/i })
  await expect(skipBtn).toBeVisible({ timeout: 3_000 })
  await skipBtn.click()

  // Drawer closes — heading disappears.
  await expect(heading).not.toBeVisible({ timeout: 5_000 })
})
