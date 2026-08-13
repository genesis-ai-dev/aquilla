import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * InviteLinkTab — email validation error on invalid input.
 *
 * ProjectMembersPage InviteLinkTab has an optional recipient email input
 * (id="pm-invite-email"). When a non-empty, syntactically invalid email is
 * entered and the user clicks "Create invite link", handleCreate() sets
 * emailError:
 *   "Enter a valid email address, or leave blank for an open link."
 *
 * Sharing opens from Settings → Members → Add a member → Invite link.
 */
test("share invite link email validation error shown for invalid email", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ShareEmailVal ${Date.now()}` })
  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(seeded.projectId)

  const emailInput = dialog.locator("#pm-invite-email")
  await expect(emailInput).toBeVisible({ timeout: 3_000 })
  await emailInput.fill("not-an-email")

  const createLinkBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createLinkBtn).toBeVisible({ timeout: 2_000 })
  await createLinkBtn.click()

  await expect(
    dialog.getByText(/Enter a valid email address, or leave blank for an open link/i)
  ).toBeVisible({ timeout: 3_000 })
})
