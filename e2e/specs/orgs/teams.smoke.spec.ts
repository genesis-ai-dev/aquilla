import { test, expect } from "../../helpers/multi-user"

/**
 * Teams — create a team.
 *
 * TeamsList.tsx renders a "New team" button that expands an inline form.
 * Submitting creates the team via the auth-worker API and navigates to
 * /teams/:groupId (TeamDetail). This spec verifies:
 *  1. /teams page loads and shows the "New team" button.
 *  2. The inline form appears after clicking "New team".
 *  3. Submitting creates the team and navigates to the team detail page.
 *  4. The detail page shows the team name as a heading.
 *
 * Teams are org-scoped. Alice is logged in as the owner of "Acme" org.
 */
test("create a team and navigate to its detail page", async ({ alice }) => {
  await alice.goto("/teams")
  // 1. "New team" button is visible (only rendered for owners/admins).
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  // 2. Inline form appears with "Team name" placeholder input.
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })

  const teamName = `E2E Team ${Date.now()}`
  await nameInput.fill(teamName)

  // 3. Submit the form — "Create" button.
  await alice.getByRole("button", { name: /^Create$/i }).click()

  // The form navigates to /teams/:groupId on success.
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  // 4. The team detail page shows the team name.
  await expect(alice.getByText(teamName).first()).toBeVisible({ timeout: 5_000 })
})
