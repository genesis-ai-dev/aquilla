import { test, expect } from "../../helpers/multi-user"

/**
 * Team rename — TeamDetail page.
 *
 * The teams.smoke.spec.ts already creates a team and navigates to its
 * detail page. This spec extends that by:
 *   1. Creating a team
 *   2. Clicking "Edit" (inline rename — no dialog)
 *   3. Changing the name and saving
 *   4. Verifying the new name appears in the h1
 */
test("team rename saves new name on team detail page", async ({ alice }) => {
  await alice.goto("/teams")
  // Create a new team.
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const originalName = `RenameTeam ${Date.now()}`
  await nameInput.fill(originalName)
  await alice.getByRole("button", { name: /^Create$/i }).click()

  // Navigate to the team detail page.
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  // h1 shows the team name.
  await expect(alice.locator("h1").filter({ hasText: originalName })).toBeVisible({ timeout: 5_000 })

  // "Edit" link opens inline rename input.
  const editBtn = alice.getByRole("button", { name: /^Edit$/i })
  await expect(editBtn).toBeVisible({ timeout: 5_000 })
  await editBtn.click()

  // Inline input with the current name.
  const editInput = alice.locator('input[value="' + originalName + '"]')
    .or(alice.locator("input.border.rounded").first())
  await expect(editInput).toBeVisible({ timeout: 3_000 })

  const newTeamName = `${originalName} — renamed`
  await editInput.fill(newTeamName)

  // Save button.
  await alice.getByRole("button", { name: /^Save$/i }).first().click()

  // h1 updates to new name.
  await expect(alice.locator("h1").filter({ hasText: newTeamName })).toBeVisible({ timeout: 5_000 })
})
