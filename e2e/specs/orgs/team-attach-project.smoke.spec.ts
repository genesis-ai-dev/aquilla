import { test, expect, orgRoute } from "../../helpers/multi-user"
import { pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TeamDetail — attach a project to a team.
 *
 * TeamDetail.tsx has an "Attach project" control (admin only) on the Projects
 * tab. Clicking it opens a modal with a project select + role select +
 * "Attach" and "Cancel" buttons. Clicking "Attach" adds the project to the
 * team's projects DataTable.
 *
 * This spec: creates a project → creates a team → navigates to the team
 * detail → clicks "Attach project" → selects the project → clicks "Attach"
 * → the project appears in the team's projects table.
 */
test("team attach project adds project to team project list", async ({ alice }) => {
  // Create a project to attach.
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `AttachProj ${Date.now()}`
  await dash.createProject({ name: projName })

  // Navigate to teams and create a new team.
  await alice.goto(orgRoute(alice, "/teams"))
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `AttachTeam ${Date.now()}`
  const nameInput = alice.locator('input[placeholder*="name"], input[type="text"]').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /Save|Create|Confirm/i }).first().click()

  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: teamName })).toBeVisible({ timeout: 5_000 })

  // Projects live on the Projects tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Projects$/i }).click()

  // Click "Attach project".
  const attachLink = alice.getByRole("button", { name: /Attach project/i })
    .or(alice.getByText(/Attach project/i).first())
  await expect(attachLink).toBeVisible({ timeout: 5_000 })
  await attachLink.click()

  // Project select appears — pick our project.
  const projectSelect = alice.getByRole("combobox", { name: "Project to attach" })
  await expect(projectSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, projectSelect, projName)

  // Click "Attach".
  const attachBtn = alice.getByRole("button", { name: /^Attach$/i })
  await expect(attachBtn).toBeVisible({ timeout: 3_000 })
  await attachBtn.click()

  // Project appears in the team's projects table. The attached row uniquely
  // carries an "Actions for <name>" trigger (three-dot menu).
  await expect(
    alice.getByRole("button", { name: `Actions for ${projName}` }),
  ).toBeVisible({ timeout: 8_000 })
})
