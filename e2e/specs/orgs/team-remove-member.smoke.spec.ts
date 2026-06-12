import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * TeamDetail — remove a member from a team.
 *
 * TeamDetail.tsx renders each team member row with a
 * "Remove <username>" button (aria-label="Remove <username>").
 * Clicking it calls removeTeamMember and the row disappears.
 *
 * This spec: seeds bob in alice's org → creates a team → adds bob →
 * clicks "Remove bob" → verifies bob no longer appears in the members list.
 */
test("team remove member button removes the member from the team", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Navigate to teams and create a team.
  await alice.goto("/teams")
  await alice.waitForLoadState("networkidle")

  const dash = new Dashboard(alice)
  void dash // suppress unused var
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `RemoveMember ${Date.now()}`
  const nameInput = alice.locator('input[placeholder*="name"], input[type="text"]').first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  const saveBtn = alice.getByRole("button", { name: /Save|Create|Confirm/i }).first()
  await saveBtn.click()

  // Navigate to the team detail.
  const teamLink = alice.getByRole("link", { name: teamName })
    .or(alice.getByText(teamName).first())
  await expect(teamLink).toBeVisible({ timeout: 10_000 })
  await teamLink.click()
  await alice.waitForURL(/\/teams\/\d+/, { timeout: 5_000 })

  // Add bob to the team.
  const addMemberBtn = alice.getByRole("button", { name: /Add member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 5_000 })
  await addMemberBtn.click()

  const memberSelect = alice.getByRole("combobox", { name: "Member to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, memberSelect, "bob")
  const confirmAdd = alice.getByRole("button", { name: /^Add$/i })
  await expect(confirmAdd).toBeEnabled({ timeout: 3_000 })
  await confirmAdd.click()

  // Wait for bob to appear in the team members list.
  await expect(alice.getByText("bob")).toBeVisible({ timeout: 8_000 })

  // Remove bob.
  const removeBtn = alice.getByRole("button", { name: /Remove bob/i })
  await expect(removeBtn).toBeVisible({ timeout: 5_000 })
  await removeBtn.click()

  // Bob is no longer in the team.
  await expect(alice.getByText("bob")).not.toBeVisible({ timeout: 5_000 })
})
