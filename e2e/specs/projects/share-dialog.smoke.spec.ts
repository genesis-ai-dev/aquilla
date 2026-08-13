import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * Project sharing — Add a member dialog (Settings → Members).
 *
 * Sharing used to open from the workspace sidebar More menu (SharePanel).
 * It now lives at `/project/:id/settings/members`: "Add a member" opens a
 * dialog with "Add members" and "Invite link" tabs.
 */
test("add a member dialog opens with members and invite-link tabs", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Share ${Date.now()}` })
  const settings = new ProjectSettings(alice)
  const dialog = await settings.openAddMemberDialog(seeded.projectId)

  await expect(dialog.getByRole("heading", { name: /Add a member/i })).toBeVisible()
  await expect(dialog.getByRole("tab", { name: /^Add members$/i })).toBeVisible({ timeout: 3_000 })
  await expect(dialog.getByRole("tab", { name: /^Invite link$/i })).toBeVisible({ timeout: 3_000 })

  await dialog.getByRole("tab", { name: /^Invite link$/i }).click()
  await expect(dialog.getByRole("button", { name: /Create invite link/i })).toBeVisible({ timeout: 3_000 })

  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
