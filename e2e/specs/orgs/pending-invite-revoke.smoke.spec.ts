import { test, expect, orgRoute } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * PendingInvitesSection — create an invite link then revoke it from /members.
 *
 * MembersPage.tsx renders <PendingInvitesSection> which shows pending org
 * invites (those not yet redeemed). Each row has an aria-label="Revoke
 * invitation to <projectName>" trash icon button. Clicking it optimistically
 * removes the row.
 *
 * Flow:
 *   1. Alice creates a project and opens Settings → Members → Add a member.
 *   2. She creates an invite link on the "Invite link" tab.
 *   3. She navigates to /members.
 *   4. The PendingInvitesSection shows the pending invite row.
 *   5. She clicks "Revoke invitation to <name>".
 *   6. The row disappears (optimistic removal).
 */
test("pending invite appears on /members and can be revoked", async ({ alice }) => {
  const name = `RevokeInvite ${Date.now()}`
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name })
  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(seeded.projectId)
  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeEnabled({ timeout: 5_000 })
  await createBtn.click()
  // Wait for link creation to complete.
  await expect(
    dialog.getByRole("button", { name: /Copy/i })
      .or(dialog.getByText(/\/join\//i).first())
  ).toBeVisible({ timeout: 10_000 })
  await alice.keyboard.press("Escape")

  // Navigate to /members.
  await alice.goto(orgRoute(alice, "/members"))
  // The PendingInvitesSection should show the invite row for our project.
  const revokeBtn = alice.getByRole("button", {
    name: new RegExp(`Revoke invitation to ${name}`, "i"),
  })
  await expect(revokeBtn).toBeVisible({ timeout: 10_000 })

  // Since no email was provided, the "Open link" badge should be visible.
  const inviteRow = alice.locator("li").filter({ hasText: name }).first()
  await expect(inviteRow.getByText(/open link/i)).toBeVisible({ timeout: 3_000 })

  // Click revoke — row disappears optimistically.
  await revokeBtn.click()
  await expect(revokeBtn).not.toBeVisible({ timeout: 5_000 })
})
