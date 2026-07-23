import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SharePanel InviteLinkTab — email validation error on invalid input.
 *
 * SharePanel.tsx InviteLinkTab has an optional recipient email input
 * (id="invite-email"). When a non-empty, syntactically invalid email is
 * entered and the user clicks "Create invite link", handleCreate() sets
 * emailError:
 *   "Enter a valid email address, or leave blank for an open link."
 *
 * Share now opens from the workspace sidebar's "More project options"
 * popover (SidebarProjectSection) — project cards no longer have a Share
 * button.
 *
 * This spec: open project workspace → More project options → Share →
 * Invite link tab → type an invalid email → click "Create invite link" →
 * verify the error message appears.
 */
test("share invite link email validation error shown for invalid email", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ShareEmailVal ${Date.now()}` })

  // Enter the workspace.
  await openSeededProject(alice, seeded)

  // Open the share dialog from the sidebar "More" menu.
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await expect(shareBtn).toBeVisible({ timeout: 5_000 })
  await shareBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Switch to the "Invite link" tab.
  const inviteLinkTab = dialog.getByRole("button", { name: /Invite link/i })
  await expect(inviteLinkTab).toBeVisible({ timeout: 3_000 })
  await inviteLinkTab.click()

  // The recipient email input is visible.
  const emailInput = dialog.locator("#invite-email")
  await expect(emailInput).toBeVisible({ timeout: 3_000 })

  // Type an invalid email.
  await emailInput.fill("not-an-email")

  // Click "Create invite link".
  const createLinkBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createLinkBtn).toBeVisible({ timeout: 2_000 })
  await createLinkBtn.click()

  // Error message appears.
  await expect(
    dialog.getByText(/Enter a valid email address, or leave blank for an open link/i)
  ).toBeVisible({ timeout: 3_000 })
})
