import { test, expect } from "../../helpers/multi-user"
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
 * This spec: seeds bob in alice's org → creates a team → adds bob via the
 * AQU-735 multi-select dialog → clicks "Remove bob" → verifies bob no longer
 * appears in the members list.
 */
test("team remove member button removes the member from the team", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Navigate to teams and create a team.
  await alice.goto("/teams")
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

  // Creating a team auto-navigates to its detail page (/teams/:id) — no click
  // needed. (A team-name locator would resolve to the breadcrumb "current page"
  // span, which is aria-disabled, so clicking it hangs until the test times out.)
  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })

  // Add bob to the team via multi-select (AQU-735).
  const addMemberBtn = alice.getByRole("button", { name: /Add member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 5_000 })
  await addMemberBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  const memberSelect = dialog.getByRole("combobox", { name: "Members to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await memberSelect.click()
  await alice.getByRole("checkbox", { name: "bob" }).check()
  const confirmAdd = dialog.getByRole("button", { name: /^Add$/i })
  await expect(confirmAdd).toBeEnabled({ timeout: 3_000 })
  await confirmAdd.click()

  // Wait for bob's member row. The member row uniquely carries "Remove bob".
  const removeBtn = alice.getByRole("button", { name: /Remove bob/i })
  await expect(removeBtn).toBeVisible({ timeout: 8_000 })

  // Remove bob.
  await removeBtn.click()

  // Bob's row is gone (the remove action disappears with it).
  await expect(removeBtn).not.toBeVisible({ timeout: 5_000 })
})
