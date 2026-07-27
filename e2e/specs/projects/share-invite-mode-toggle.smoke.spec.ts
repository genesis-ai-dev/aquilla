import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * UsernameTypeahead mode toggle (@user vs email).
 *
 * UsernameTypeahead.tsx has two mode-selector buttons:
 *   - "@user" (title="Invite an existing Aquilla user") — username mode (default)
 *   - "email" (title="Invite by email — they'll be prompted to sign up if needed")
 *
 * The SharePanel Members tab now renders the typeahead with
 * showModeToggle={false} (direct grants need a real user id), so the toggle
 * lives on the org Members page's "Add to projects" dialog
 * (MultiProjectInviteDialog, showModeToggle={true}). The button is disabled
 * until at least one project exists, so this spec creates one first.
 *
 * Switching to email mode swaps the recipient input to type="email";
 * switching back restores the username typeahead (type="text").
 */
test("share panel invite mode toggles between @user and email", async ({ alice }) => {
  await seedProjectWithFile(await jwtFor("alice"), { name: `InviteMode ${Date.now()}` })

  // The mode toggle lives in the Members page "Add to projects" dialog.
  await alice.goto(orgRoute(alice, "/members"))
  const addToProjectsBtn = alice.getByRole("button", { name: /Add to projects/i })
  await expect(addToProjectsBtn).toBeVisible({ timeout: 10_000 })
  await expect(addToProjectsBtn).toBeEnabled({ timeout: 10_000 })
  await addToProjectsBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // "@user" button is visible.
  const userModeBtn = dialog.getByRole("button", { name: "@user" })
  await expect(userModeBtn).toBeVisible({ timeout: 5_000 })

  // "email" button is visible.
  const emailModeBtn = dialog.getByRole("button", { name: "email" })
  await expect(emailModeBtn).toBeVisible({ timeout: 3_000 })

  // Switch to email mode — recipient input becomes type="email".
  await emailModeBtn.click()
  const emailInput = dialog.locator('input[type="email"]#invite-recipient')
  await expect(emailInput).toBeVisible({ timeout: 5_000 })

  // Switch back to @user mode — email input is replaced by the typeahead.
  await userModeBtn.click()
  await expect(emailInput).not.toBeVisible({ timeout: 3_000 })
  await expect(dialog.locator('input[type="text"]#invite-recipient')).toBeVisible({ timeout: 3_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
