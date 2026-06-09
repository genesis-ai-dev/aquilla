import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * TeamDetail — change a team member's role via the role select.
 *
 * TeamDetail.tsx renders a <select> with aria-label="Role for ${m.username}"
 * for each member when the viewer is org owner. The select contains role
 * options: viewer(100), commenter(200), reviewer(300), contributor(400),
 * project_lead(500), maintainer(600), owner(700).
 *
 * This spec: seed bob in alice's org → create a team → add bob as a team
 * member → navigate to team detail → change "Role for bob" to "maintainer"
 * → verify the select shows 600.
 */
test("team member role select changes member role", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Create a team.
  await alice.goto("/teams")
  await alice.waitForLoadState("networkidle")

  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `RoleTeam ${Date.now()}`
  const nameInput = alice.locator('input[placeholder*="name"], input[type="text"]').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /Save|Create|Confirm/i }).first().click()

  // Navigate to team detail.
  const teamLink = alice.getByRole("link", { name: teamName })
    .or(alice.getByText(teamName).first())
  await expect(teamLink).toBeVisible({ timeout: 10_000 })
  await teamLink.click()
  await alice.waitForLoadState("networkidle")

  // Add bob as a member.
  const usernameInput = alice.locator('input[placeholder*="username" i]')
    .or(alice.locator('input[placeholder="Username"]'))
    .first()
  await expect(usernameInput).toBeVisible({ timeout: 10_000 })
  await usernameInput.fill("bob")

  const addBtn = alice.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeVisible({ timeout: 3_000 })
  await addBtn.click()

  // Bob now appears in the member list.
  await expect(alice.getByText("bob").first()).toBeVisible({ timeout: 10_000 })

  // The "Role for bob" select is visible (alice is owner).
  const roleSelect = alice.locator('[aria-label="Role for bob"]')
  await expect(roleSelect).toBeVisible({ timeout: 5_000 })

  // Change bob's role to maintainer (600).
  await roleSelect.selectOption("600")
  await expect(roleSelect).toHaveValue("600")
})
