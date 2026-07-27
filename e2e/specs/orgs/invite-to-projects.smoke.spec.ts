import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * MultiProjectInviteDialog — "Add to projects" on the Members page.
 *
 * AQU-322 renamed the affordance from "Invite to projects…" to
 * "Add to projects". MembersPage.tsx renders the button (org owner/admin
 * only) and disables it until the org has at least one accessible project.
 * Clicking it opens MultiProjectInviteDialog with DialogTitle "Add to projects".
 *
 * Alice is the org owner of "Acme" so the button should be visible for her.
 * This spec verifies the dialog opens and Escape closes it.
 */
test("invite to projects dialog opens from members page", async ({ alice }) => {
  // The button is disabled while the org has zero accessible projects,
  // so create one first.
  await seedProjectWithFile(await jwtFor("alice"), { name: `InviteOpenProj ${Date.now()}` })

  await alice.goto(orgRoute(alice, "/members"))
  // "Add to projects" button — only visible to org owners/admins.
  const inviteBtn = alice.getByRole("button", { name: /Add to projects/i })
  await expect(inviteBtn).toBeEnabled({ timeout: 10_000 })
  await inviteBtn.click()

  // MultiProjectInviteDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Add to projects/i })).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
