import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * Invite link tab — "Copy URL" button shows "Copied!" confirmation.
 *
 * After generating an invite link, InviteLinkTab shows:
 *   - A read-only input with the invite URL
 *   - A Button with aria-label="Copy URL"
 *   - After clicking: a "Copied!" confirmation paragraph appears
 */
test("share panel Copy URL button shows Copied confirmation", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CopyUrl ${Date.now()}` })
  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(seeded.projectId)

  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeVisible({ timeout: 5_000 })
  await createBtn.click()

  const copyBtn = dialog.getByRole("button", { name: "Copy URL" }).first()
  await expect(copyBtn).toBeVisible({ timeout: 10_000 })
  await copyBtn.click()

  await expect(dialog.getByText(/Copied!/i)).toBeVisible({ timeout: 3_000 })

  await alice.keyboard.press("Escape")
})
