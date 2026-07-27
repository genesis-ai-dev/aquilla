import { test, expect, orgRoute } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * TeamDetail — change a team member's role via the role select.
 *
 * TeamDetail.tsx renders a Base UI Select with aria-label="Role for
 * ${m.username}" for each member when the viewer is org owner. The select
 * contains role options: viewer(100), commenter(200), reviewer(300),
 * contributor(400), project_lead(500), maintainer(600), owner(700).
 *
 * This spec: seed bob in alice's org → create a team → add bob as a team
 * member → navigate to team detail → change "Role for bob" to "maintainer"
 * → verify the select trigger shows "maintainer".
 */
test("team member role select changes member role", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Create a team.
  await alice.goto(orgRoute(alice, "/teams"))
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `RoleTeam ${Date.now()}`
  const nameInput = alice.locator('input[placeholder*="name"], input[type="text"]').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /Save|Create|Confirm/i }).first().click()

  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: teamName })).toBeVisible({ timeout: 5_000 })

  // Add bob as a member via the "Member to add" select.
  const addMemberBtn = alice.getByRole("button", { name: /Add member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 10_000 })
  await addMemberBtn.click()

  const memberSelect = alice.getByRole("combobox", { name: "Member to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, memberSelect, "bob")

  const addBtn = alice.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeVisible({ timeout: 3_000 })
  await addBtn.click()

  // Bob now appears in the member list.
  await expect(alice.getByText("bob").first()).toBeVisible({ timeout: 10_000 })

  // The "Role for bob" select is visible (alice is owner).
  const roleSelect = alice.getByRole("combobox", { name: "Role for bob" })
  await expect(roleSelect).toBeVisible({ timeout: 5_000 })

  // Change bob's role to maintainer (600) — the trigger shows the label.
  await pickSelectOption(alice, roleSelect, "maintainer")
  await expectSelectValue(roleSelect, /Maintainer/i)
})
