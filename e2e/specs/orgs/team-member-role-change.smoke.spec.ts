import { test, expect, orgRoute } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * TeamDetail — change a team member's role via the row actions dialog.
 *
 * TeamDetail shows the current role as plain text in the Role column. Owners
 * open the three-dot menu → "Change role" → dialog with a Base UI Select
 * (aria-label="Role for ${username}") → Save.
 *
 * This spec: seed bob in alice's org → create a team → add bob as a team
 * member (AQU-735 multi-select) → change bob's role to maintainer via the
 * dialog → verify the Role column shows "Maintainer".
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
  const createDialog = alice.getByRole("dialog")
  await expect(createDialog).toBeVisible({ timeout: 3_000 })
  const nameInput = createDialog.getByLabel(/^Team name$/i)
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(teamName)
  await createDialog.getByRole("button", { name: /^Create$/i }).click()

  await alice.waitForURL(/\/teams\/\d+/, { timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: teamName })).toBeVisible({ timeout: 5_000 })

  // Members live on the Members tab (Linear-style team page).
  await alice.getByRole("tab", { name: /^Members$/i }).click()

  // Add bob via the multi-select "Members to add" combobox (AQU-735).
  const addMemberBtn = alice.getByRole("button", { name: /Add (a )?member/i })
  await expect(addMemberBtn).toBeVisible({ timeout: 10_000 })
  await addMemberBtn.click()

  const addDialog = alice.getByRole("dialog")
  await expect(addDialog).toBeVisible({ timeout: 3_000 })
  const memberSelect = addDialog.getByRole("combobox", { name: "Members to add" })
  await expect(memberSelect).toBeVisible({ timeout: 3_000 })
  await memberSelect.click()
  const bobOption = alice.getByRole("option", { name: "bob" })
  await expect(bobOption).toBeVisible({ timeout: 3_000 })
  await bobOption.click()

  const addBtn = addDialog.getByRole("button", { name: /^Add$/i })
  await expect(addBtn).toBeEnabled({ timeout: 3_000 })
  await addBtn.click()

  // Bob now appears in the member list.
  const actionsBtn = alice.getByRole("button", { name: /Actions for bob/i })
  await expect(actionsBtn).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByText("Contributor")).toBeVisible({ timeout: 5_000 })

  // Open Change role dialog from the three-dot menu.
  await actionsBtn.click()
  await alice.getByRole("menuitem", { name: /Change role/i }).click()
  const roleDialog = alice.getByRole("dialog", { name: /Change role for bob/i })
  await expect(roleDialog).toBeVisible({ timeout: 3_000 })

  const roleSelect = roleDialog.getByRole("combobox", { name: "Role for bob" })
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, roleSelect, /^Maintainer\b/i)
  await expectSelectValue(roleSelect, /Maintainer/i)
  await roleDialog.getByRole("button", { name: /^Save$/i }).click()

  // Wait for the dialog to close, then assert the Role column (avoid matching
  // leftover select/portal text that also contains "maintainer").
  await expect(alice.getByRole("dialog", { name: /Change role for bob/i })).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByRole("row", { name: /bob/i }).getByText(/^Maintainer$/i)).toBeVisible({
    timeout: 8_000,
  })
})
