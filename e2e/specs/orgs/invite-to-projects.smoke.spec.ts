import { test, expect } from "../../helpers/multi-user"

/**
 * MultiProjectInviteDialog — "Invite to projects…" on the Members page.
 *
 * MembersPage.tsx has an "Invite to projects…" button (org owner/admin only).
 * Clicking it opens MultiProjectInviteDialog with:
 *   - DialogTitle "Invite to projects"
 *
 * Alice is the org owner of "Acme" so the button should be visible for her.
 * This spec verifies the dialog opens and Cancel closes it.
 */
test("invite to projects dialog opens from members page", async ({ alice }) => {
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // "Invite to projects…" button — only visible to org owners/admins.
  const inviteBtn = alice.getByRole("button", { name: /Invite to projects/i })
  await expect(inviteBtn).toBeVisible({ timeout: 10_000 })
  await inviteBtn.click()

  // MultiProjectInviteDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Invite to projects/i })).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
