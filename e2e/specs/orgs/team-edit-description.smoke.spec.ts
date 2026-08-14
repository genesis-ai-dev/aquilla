import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Team description — Team settings (inline description field).
 *
 * Create a team, open settings, fill description, blur to save, then verify
 * the description appears on the team detail page.
 */
test("team edit saves description on team detail page", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const teamName = `DescTeam ${Date.now()}`
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /^Create$/i }).click()

  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })

  await alice.getByRole("link", { name: /Team settings/i }).click()
  await alice.waitForURL(/\/teams\/\d+\/settings$/, { timeout: 10_000 })

  const descInput = alice.getByLabel(/^Description$/i)
  await expect(descInput).toBeVisible({ timeout: 3_000 })

  const description = "A team for testing descriptions"
  await descInput.fill(description)
  const saveResponse = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/groups\/\d+/.test(response.url()) &&
      response.ok(),
    { timeout: 10_000 },
  )
  await descInput.blur()
  await saveResponse
  await expect(descInput).toHaveValue(description)

  await alice.getByRole("link", { name: teamName }).first().click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await expect(alice.getByText(description)).toBeVisible({ timeout: 5_000 })
})
