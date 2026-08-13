import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * Settings → Members → Add a member → Invite link tab.
 *
 * After clicking "Create invite link", the link is generated and a
 * copy button appears.
 */
test("share panel invite link tab creates a link", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `InviteLink ${Date.now()}` })
  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(seeded.projectId)

  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeVisible({ timeout: 3_000 })
  await expect(createBtn).toBeEnabled()

  await expect(dialog.locator("#pm-invite-email")).toBeVisible({ timeout: 3_000 })

  await createBtn.click()

  await expect(
    dialog.getByRole("button", { name: /Copy/i })
      .or(dialog.getByText(/\/join\//i).first())
  ).toBeVisible({ timeout: 10_000 })

  await alice.keyboard.press("Escape")
})
