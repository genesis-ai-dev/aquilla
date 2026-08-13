import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Team rename — Team settings (inline name field).
 *
 * Create a team, open settings via the gear, edit the name, blur to save,
 * then verify the team detail heading shows the new name.
 */
test("team rename saves new name on team detail page", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/teams"))
  const newTeamBtn = alice.getByRole("button", { name: /New team/i })
  await expect(newTeamBtn).toBeVisible({ timeout: 10_000 })
  await newTeamBtn.click()

  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const originalName = `RenameTeam ${Date.now()}`
  await nameInput.fill(originalName)
  await alice.getByRole("button", { name: /^Create$/i }).click()

  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await expect(alice.locator("h1").filter({ hasText: originalName })).toBeVisible({
    timeout: 5_000,
  })

  await alice.getByRole("link", { name: /Team settings/i }).click()
  await alice.waitForURL(/\/teams\/\d+\/settings$/, { timeout: 10_000 })

  const editInput = alice.getByLabel(/^Team name$/i)
  await expect(editInput).toBeVisible({ timeout: 3_000 })
  await expect(editInput).toHaveValue(originalName)

  const newTeamName = `${originalName} — renamed`
  await editInput.fill(newTeamName)
  const saveResponse = alice.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/groups\/\d+/.test(response.url()) &&
      response.ok(),
    { timeout: 10_000 },
  )
  await editInput.blur()
  await saveResponse
  await expect(editInput).toHaveValue(newTeamName)

  // Back to team detail via breadcrumb / settings parent.
  await alice.getByRole("link", { name: newTeamName }).first().click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await expect(alice.locator("h1").filter({ hasText: newTeamName })).toBeVisible({
    timeout: 5_000,
  })
})
