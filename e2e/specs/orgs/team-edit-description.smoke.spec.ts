import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * TeamDetail — editing the team description.
 *
 * TeamDetail.tsx has an inline "Edit" button (shown to admins) that reveals:
 *   - input[placeholder="Team name"]
 *   - input[placeholder="Description (optional)"]
 *   - Save / Cancel buttons
 *
 * This spec: create a team → click "Edit" → fill the description input →
 * save → verify the new description text appears on the team detail page.
 */
test("team edit saves description on team detail page", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  // Create a new team.
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const teamName = `DescTeam ${Date.now()}`
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /^Create$/i }).click()

  // Navigate to the team detail page.
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  // Click Edit to enter edit mode.
  const editBtn = alice.getByRole("button", { name: /^Edit$/i })
  await expect(editBtn).toBeVisible({ timeout: 5_000 })
  await editBtn.click()

  // The description input appears.
  const descInput = alice.locator('input[placeholder="Description (optional)"]')
  await expect(descInput).toBeVisible({ timeout: 3_000 })

  // Fill the description.
  const description = "A team for testing descriptions"
  await descInput.fill(description)

  // Save.
  await alice.getByRole("button", { name: /^Save$/i }).click()

  // The description text is now shown on the page.
  await expect(alice.getByText(description)).toBeVisible({ timeout: 5_000 })
})
