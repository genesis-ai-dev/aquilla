import { test, expect } from "../../helpers/multi-user"

/**
 * Team delete — TeamDetail page inline confirmation.
 *
 * TeamDetail.tsx has a "Delete team" button. Clicking it reveals an
 * inline confirmation: description + "Confirm" and "Cancel" buttons.
 * Cancel dismisses without deleting. Confirm calls deleteTeam and
 * navigates away to /teams.
 *
 * This spec creates a team, confirms the delete dialog appears with
 * Cancel, then tests the full delete flow.
 */
test("team delete confirm workflow navigates back to teams list", async ({ alice }) => {
  await alice.goto("/teams")
  await alice.waitForLoadState("networkidle")

  // Create a team to delete.
  await alice.getByRole("button", { name: /New team/i }).click()
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(`DeleteTeam ${Date.now()}`)
  await alice.getByRole("button", { name: /^Create$/i }).click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await alice.waitForLoadState("networkidle")

  // "Delete team" button reveals inline confirmation.
  const deleteTeamBtn = alice.getByRole("button", { name: /Delete team/i })
  await expect(deleteTeamBtn).toBeVisible({ timeout: 5_000 })
  await deleteTeamBtn.click()

  // Inline confirmation appears with description text.
  await expect(
    alice.getByText(/This removes the team and all its grants/i)
  ).toBeVisible({ timeout: 3_000 })

  // "Cancel" dismisses.
  const cancelBtn = alice.getByRole("button", { name: /^Cancel$/i }).first()
  await expect(cancelBtn).toBeVisible()
  await cancelBtn.click()
  await expect(
    alice.getByText(/This removes the team and all its grants/i)
  ).not.toBeVisible({ timeout: 2_000 })

  // Re-open and confirm deletion.
  await deleteTeamBtn.click()
  const confirmBtn = alice.getByRole("button", { name: /^Confirm$/i })
  await expect(confirmBtn).toBeVisible({ timeout: 3_000 })
  await confirmBtn.click()

  // After deletion navigates to /teams.
  await alice.waitForURL(/\/teams$/, { timeout: 10_000 })
})
