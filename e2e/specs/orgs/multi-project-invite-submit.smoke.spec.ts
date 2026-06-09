import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MultiProjectInviteDialog — fill recipient + select project + Invite.
 *
 * The dialog (opened from /members) has:
 *   - UsernameTypeahead input (id="invite-username")
 *   - Project list with "Select <name>" buttons (aria-label="Select <name>")
 *   - Role select per project
 *   - "Invite" submit button (disabled until a user + project are chosen)
 *
 * This spec: seeds bob in alice's org → creates a project → opens the
 * dialog → types bob's username → selects the project → clicks Invite →
 * dialog closes (or shows confirmation).
 */
test("multi-project invite submits and closes the dialog", async ({ alice }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `InviteProj ${Date.now()}`
  await dash.createProject({ name: projName })

  // Navigate to members page.
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Open MultiProjectInviteDialog.
  const inviteBtn = alice.getByRole("button", { name: /Invite to projects/i })
  await expect(inviteBtn).toBeVisible({ timeout: 10_000 })
  await inviteBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Fill the UsernameTypeahead with "bob".
  const usernameInput = dialog.locator("#invite-username")
  await expect(usernameInput).toBeVisible({ timeout: 5_000 })
  await usernameInput.fill("bob")
  await alice.waitForTimeout(600) // allow typeahead to resolve

  // Select "bob" from typeahead suggestion.
  const suggestion = alice.getByRole("option", { name: /bob/i })
    .or(alice.locator('[role="listbox"] [role="option"]').filter({ hasText: "bob" }))
    .or(alice.getByText("bob").first())
  await expect(suggestion).toBeVisible({ timeout: 3_000 })
  await suggestion.click()

  // Select the project by clicking the "Select <projName>" button.
  const selectProjectBtn = dialog.getByRole("button", { name: new RegExp(`Select ${projName}`) })
  await expect(selectProjectBtn).toBeVisible({ timeout: 5_000 })
  await selectProjectBtn.click()

  // Invite button becomes enabled.
  const inviteSubmitBtn = dialog.getByRole("button", { name: /^Invite$/i })
  await expect(inviteSubmitBtn).toBeEnabled({ timeout: 3_000 })
  await inviteSubmitBtn.click()

  // Dialog closes after successful invite.
  await expect(dialog).not.toBeVisible({ timeout: 8_000 })
})
