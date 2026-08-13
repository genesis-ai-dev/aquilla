import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Team delete — Team settings Danger zone.
 *
 * Admins open Team settings from the gear on TeamDetail, then use Delete team
 * in the Danger zone. Cancel dismisses without deleting; Confirm calls
 * deleteTeam and navigates back to /teams.
 */
test("team delete confirm workflow navigates back to teams list", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  await alice.getByRole("button", { name: /New team/i }).click()
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(`DeleteTeam ${Date.now()}`)
  await alice.getByRole("button", { name: /^Create$/i }).click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })

  await alice.getByRole("link", { name: /Team settings/i }).click()
  await alice.waitForURL(/\/teams\/\d+\/settings$/, { timeout: 10_000 })
  await expect(alice.locator("h1").filter({ hasText: /Team settings/i })).toBeVisible({
    timeout: 5_000,
  })

  const deleteTeamBtn = alice.getByRole("button", { name: /Delete team/i })
  await expect(deleteTeamBtn).toBeVisible({ timeout: 5_000 })
  await deleteTeamBtn.click()

  await expect(
    alice.getByText(/This removes the team and all its grants/i),
  ).toBeVisible({ timeout: 3_000 })

  const cancelBtn = alice.getByRole("button", { name: /^Cancel$/i }).first()
  await expect(cancelBtn).toBeVisible()
  await cancelBtn.click()
  await expect(
    alice.getByText(/This removes the team and all its grants/i),
  ).not.toBeVisible({ timeout: 2_000 })

  await deleteTeamBtn.click()
  const confirmBtn = alice.getByRole("button", { name: /^Confirm$/i })
  await expect(confirmBtn).toBeVisible({ timeout: 3_000 })
  await confirmBtn.click()

  await alice.waitForURL(/\/teams$/, { timeout: 10_000 })
})
