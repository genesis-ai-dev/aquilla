import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"

/**
 * MultiProjectInviteDialog — fill recipient + select project + submit.
 *
 * AQU-322 renamed the flow to "Add to projects". The dialog (opened from
 * /members via the "Add to projects" button) has:
 *   - UsernameTypeahead input (id="invite-recipient"); suggestions are
 *     plain buttons labelled with the username
 *   - Project rows with role=checkbox toggles (aria-label="Select <name>")
 *   - Role select per selected project
 *   - "Add to projects" submit button (stays enabled; validates on click)
 *   - On success the dialog STAYS OPEN, shows an "added" chip per project,
 *     and the Cancel button becomes "Close".
 *
 * This spec: seeds bob in alice's org → creates a project → opens the
 * dialog → types bob's username → selects the project → submits → verifies
 * the per-project "added" confirmation → closes the dialog.
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
  const inviteBtn = alice.getByRole("button", { name: /Add to projects/i })
  await expect(inviteBtn).toBeEnabled({ timeout: 10_000 })
  await inviteBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Fill the UsernameTypeahead with "bob".
  const usernameInput = dialog.locator("#invite-recipient")
  await expect(usernameInput).toBeVisible({ timeout: 5_000 })
  await usernameInput.fill("bob")

  // Pick "bob" from the typeahead suggestions (plain buttons, no listbox role).
  const suggestion = alice.getByRole("button", { name: /^bob$/ })
  await expect(suggestion).toBeVisible({ timeout: 5_000 })
  await suggestion.click()

  // Select the project — row toggles are role=checkbox ("Select <name>").
  const selectProjectToggle = dialog.getByRole("checkbox", { name: `Select ${projName}` })
  await expect(selectProjectToggle).toBeVisible({ timeout: 5_000 })
  await selectProjectToggle.click()

  // Submit button ("Add to projects") becomes enabled.
  const submitBtn = dialog.getByRole("button", { name: /^Add to projects$/i })
  await expect(submitBtn).toBeEnabled({ timeout: 3_000 })
  await submitBtn.click()

  // Success: the dialog stays open and shows a per-project "added" chip.
  await expect(dialog.getByText("added")).toBeVisible({ timeout: 8_000 })

  // Cancel becomes Close after a successful add; close the dialog. The
  // dialog chrome's X button is also named "Close" (sr-only), so exclude it
  // via its data-slot to keep strict mode happy.
  const footerClose = dialog
    .getByRole("button", { name: /^Close$/ })
    .and(alice.locator(':not([data-slot="dialog-close"])'))
  await footerClose.click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
