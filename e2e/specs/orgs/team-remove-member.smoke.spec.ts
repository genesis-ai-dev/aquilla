import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * TeamDetail — remove a member from a team.
 *
 * TeamDetail.tsx renders each team member row with a three-dot actions menu
 * ("Actions for <username>") whose menu includes "Remove from team".
 * Choosing it calls removeTeamMember and the row disappears.
 *
 * This spec: seeds bob in alice's org → creates a team → adds bob via the
 * AQU-735 multi-select dialog → opens bob's actions menu → clicks
 * "Remove from team" → verifies bob no longer appears in the members list.
 */
test("team remove member button removes the member from the team", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Navigate to teams and create a team.
  await alice.goto(orgRoute(alice, "/teams"))
  const dash = new Dashboard(alice)
  void dash // suppress unused var
  const createBtn = alice.getByRole("button", { name: /\+ New team|Create team|New team/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  const teamName = `RemoveMember ${Date.now()}`
  const createDialog = alice.getByRole("dialog")
  await expect(createDialog).toBeVisible({ timeout: 3_000 })
  const nameInput = createDialog.getByLabel(/^Team name$/i)
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await createDialog.getByRole("button", { name: /^Create$/i }).click()

  // Creating a team auto-navigates to its detail page (/teams/:id) — no click
  // needed. (A team-name locator would resolve to the breadcrumb "current page"
  // span, which is aria-disabled, so clicking it hangs until the test times out.)
  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })

  // Members live on the Members tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Members$/i }).click()

  // Add bob to the team via multi-select (AQU-735).
  const addMemberBtn = alice.getByRole("button", { name: /Add (a )?member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 5_000 })
  await addMemberBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  const memberSelect = dialog.getByRole("combobox", { name: "Members to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await memberSelect.click()
  const bobOption = alice.getByRole("option", { name: "bob" })
  await expect(bobOption).toBeVisible({ timeout: 3_000 })
  await bobOption.click()
  const confirmAdd = dialog.getByRole("button", { name: /^Add$/i })
  await expect(confirmAdd).toBeEnabled({ timeout: 3_000 })
  await confirmAdd.click()

  // Wait for bob's member row, then remove via the three-dot menu.
  const actionsBtn = alice.getByRole("button", { name: /Actions for bob/i })
  await expect(actionsBtn).toBeVisible({ timeout: 8_000 })
  await actionsBtn.click()
  const removeItem = alice.getByRole("menuitem", { name: /Remove from team/i })
  await expect(removeItem).toBeVisible({ timeout: 3_000 })
  await removeItem.click()

  // Bob's row is gone (the actions trigger disappears with it).
  await expect(actionsBtn).not.toBeVisible({ timeout: 5_000 })
})