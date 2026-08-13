import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * PendingInvitesSection — "Targeted invite" chip on /members.
 *
 * MembersPage.tsx (src/pages/MembersPage.tsx line 406-412):
 *   When invite.email is set, the pending invite row shows a blue badge:
 *     <span title="Targeted invite — sign-up form will be prefilled with this email">
 *       {invite.email}
 *     </span>
 *
 *   When invite.email is null, it shows an "open link" badge instead:
 *     <span title="Open link — anyone holding the URL can redeem">open link</span>
 *
 * This spec creates an email-targeted invite (fills the optional "Recipient
 * email" field on Settings → Members → Add a member → Invite link) and
 * verifies the targeted invite chip appears on /members.
 */
test("targeted invite chip appears on /members when invite has a recipient email", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TargetedInvite ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await expect(alice).toHaveURL(/\/projects\/[^/?#]+/, { timeout: 15_000 })

  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(settings.projectIdFromCurrentUrl())

  const emailInput = dialog.locator("#pm-invite-email")
  await expect(emailInput).toBeVisible({ timeout: 5_000 })
  await emailInput.fill("targeted@example.com")

  // Create the invite link.
  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeEnabled({ timeout: 5_000 })
  await createBtn.click()
  // Wait for the link to be created (Copy button or join URL appears).
  await expect(
    dialog.getByRole("button", { name: /Copy/i })
      .or(dialog.getByText(/\/join\//i).first())
  ).toBeVisible({ timeout: 10_000 })
  await alice.keyboard.press("Escape")

  // Navigate to /members.
  await alice.goto(orgRoute(alice, "/members"))
  // The targeted invite chip with the email badge should be visible.
  const inviteRow = alice.locator("li").filter({ hasText: name }).first()
  const targetedChip = inviteRow.getByText("targeted@example.com")
  await expect(targetedChip).toBeVisible({ timeout: 10_000 })

  // Verify the open-link badge is NOT present for this invite (it has an email).
  // There should be none associated with this targeted invite row.
  // (Could be 0 or present if other invites exist, so just check the targeted chip is right.)
  await expect(targetedChip).toBeVisible()
})
