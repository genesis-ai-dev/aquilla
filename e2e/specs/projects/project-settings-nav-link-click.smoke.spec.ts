import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectSettings — sub-menu navigation (AQU-501).
 *
 * AQU-501 replaced the old single-scroll + scroll-spy TOC with an index of
 * labeled sub-menus (NavList/NavRow, matching org Settings): picking a
 * sub-menu navigates to `?section=<group>` and renders only that group's
 * pane, with a "‹ Settings" BackLink back to the index.
 *
 * This spec: navigate to settings (index) → click the "Validation & health"
 * sub-menu → verify the Validation card becomes visible and the index list
 * is gone → click "‹ Settings" → verify the index returns.
 */
test("settings sub-menu link navigates to its pane and back", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `SettingsNavClick ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings`)
  // The index shows the sub-menu list, not any section's controls.
  const validationLink = alice.getByRole("link", { name: /Validation & health/i })
  await expect(validationLink).toBeVisible({ timeout: 10_000 })

  await validationLink.click()

  // The URL now carries the section param and the Validation section's own
  // card is visible.
  await expect(alice).toHaveURL(/\/settings\/validation(?:\?|$)/, { timeout: 5_000 })
  const validationSection = alice.locator("#section-validation")
  await expect(validationSection).toBeVisible({ timeout: 5_000 })

  // The sub-menu index is no longer shown (only the active pane).
  await expect(alice.getByRole("link", { name: /Validation & health/i })).not.toBeVisible()

  // "‹ Settings" returns to the index.
  await alice.getByRole("link", { name: /^Settings$/i }).click()
  await expect(validationSection).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByRole("link", { name: /Validation & health/i })).toBeVisible({ timeout: 5_000 })
})
