import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption } from "../../helpers/base-ui"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * TeamDetail — add a member to a team.
 *
 * TeamDetail.tsx: "Add member" button (isAdmin) reveals a <select> of
 * available org members + "Add" and "Cancel" buttons. Clicking Add calls
 * handleAddMember().
 *
 * This spec: seed bob in the org → create a team → navigate to team detail →
 * click "Add member" → select bob → click Add → bob appears in the members list.
 */
test("team add member workflow shows new member in members list", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto("/teams")
  await alice.waitForLoadState("networkidle")

  // Create a team.
  await alice.getByRole("button", { name: /New team/i }).click()
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const teamName = `AddMemberTeam ${Date.now()}`
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /^Create$/i }).click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  await alice.waitForLoadState("networkidle")

  // "Add member" button appears for admin.
  const addMemberBtn = alice.getByRole("button", { name: /Add member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 5_000 })
  await addMemberBtn.click()

  // Select appears with org members — select bob.
  const memberSelect = alice.getByRole("combobox", { name: "Member to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, memberSelect, "bob")

  // Click Add.
  const addBtn = alice.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeVisible()
  await addBtn.click()

  // Bob appears in the Members list.
  await expect(alice.getByText("bob").first()).toBeVisible({ timeout: 5_000 })
})
