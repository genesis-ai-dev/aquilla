import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * TeamDetail — add a member to a team (AQU-735 multi-select).
 *
 * TeamDetail opens an "Add members" dialog with MemberMultiSelect (same
 * checkbox combobox as named validators). One Add grants the whole batch.
 *
 * This spec: seed bob in the org → create a team → navigate to team detail →
 * click "Add member" → select bob → click Add → bob appears in the members list.
 */
test("team add member workflow shows new member in members list", async ({ alice }) => {
  // Seed bob in alice's org.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  await alice.goto(orgRoute(alice, "/teams"))
  // Create a team.
  await alice.getByRole("button", { name: /New team/i }).click()
  const nameInput = alice.locator('input[placeholder="Team name"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const teamName = `AddMemberTeam ${Date.now()}`
  await nameInput.fill(teamName)
  await alice.getByRole("button", { name: /^Create$/i }).click()
  await alice.waitForURL(/\/teams\/\d+$/, { timeout: 10_000 })
  // Members live on the Members tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Members$/i }).click()
  // "Add a member" button appears for admin.
  const addMemberBtn = alice.getByRole("button", { name: /Add (a )?member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 5_000 })
  await addMemberBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  await expect(dialog.getByRole("heading", { name: new RegExp(`Add members to '${teamName}'`) })).toBeVisible()

  // Open the multi-select combobox and pick bob (checkbox + avatar + username option).
  const memberSelect = dialog.getByRole("combobox", { name: "Members to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await memberSelect.click()
  const bobOption = alice.getByRole("option", { name: "bob" })
  await expect(bobOption).toBeVisible({ timeout: 3_000 })
  await bobOption.click()
  await expect(memberSelect).toContainText("bob", { timeout: 3_000 })

  // Click Add — enabled once someone is staged.
  const addBtn = dialog.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeEnabled({ timeout: 3_000 })
  await addBtn.click()

  // Bob appears in the Members list (row actions menu is unique to the member).
  await expect(alice.getByRole("button", { name: /Actions for bob/i })).toBeVisible({ timeout: 5_000 })
})
