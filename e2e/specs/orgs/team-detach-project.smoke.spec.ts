import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TeamDetail — detach a project from a team.
 *
 * TeamDetail.tsx renders an `aria-label="Detach ${p.name}"` button next to
 * each attached project. Clicking it removes the project from the team's
 * project list.
 *
 * This spec: creates a project → creates a team → attaches the project to
 * the team → verifies the project appears in the team's project list →
 * clicks the "Detach" button → verifies the project is removed.
 */
test("team detach project removes project from team", async ({ alice }) => {
  // Create a project to attach and then detach.
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `DetachProj ${Date.now()}`
  await dash.createProject({ name: projName })

  // Navigate to teams and create a new team.
  await alice.goto("/teams")
  await alice.waitForLoadState("networkidle")

  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `DetachTeam ${Date.now()}`
  const nameInput = alice.locator('input[placeholder*="name"], input[type="text"]').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /Save|Create|Confirm/i }).first().click()

  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: teamName })).toBeVisible({ timeout: 5_000 })

  // Attach project via "Attach project" link.
  const attachLink = alice.getByRole("button", { name: /Attach project/i })
    .or(alice.getByText(/Attach project/i))
    .first()
  await expect(attachLink).toBeVisible({ timeout: 10_000 })
  await attachLink.click()

  // Select the project from the dropdown.
  const projectSelect = alice.getByRole("combobox", { name: "Project to attach" })
  await expect(projectSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, projectSelect, projName)

  // Click "Attach".
  const attachBtn = alice.getByRole("button", { name: /^Attach$/i })
  await expect(attachBtn).toBeVisible({ timeout: 3_000 })
  await attachBtn.click()

  // The project should appear in the team's projects list.
  await expect(alice.getByText(projName).first()).toBeVisible({ timeout: 10_000 })

  // Now click "Detach <projName>" to remove the project.
  const detachBtn = alice.locator(`[aria-label="Detach ${projName}"]`)
  await expect(detachBtn).toBeVisible({ timeout: 5_000 })
  await detachBtn.click()

  // The project should no longer appear in the list.
  await expect(alice.locator(`[aria-label="Detach ${projName}"]`)).not.toBeVisible({ timeout: 5_000 })
})
