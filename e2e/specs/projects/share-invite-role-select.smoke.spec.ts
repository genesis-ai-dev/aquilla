import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { ProjectSettings } from "../../helpers/page-objects/ProjectSettings"

/**
 * InviteLinkTab — "Role" select changes the link's granted role.
 *
 * InviteLinkTab renders a Base UI Select whose trigger has aria-label="Role",
 * with LINK_ROLE_OPTIONS labels: "viewer" (100), "commenter" (200),
 * "reviewer" (300), "contributor" (400).
 */
test("share invite role select changes the link role", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `InvRole ${Date.now()}` })
  const settings = new ProjectSettings(alice)
  const dialog = await settings.openInviteLinkTab(seeded.projectId)

  // Both tabpanels stay mounted and each contains an aria-label="Role"
  // select (MemberMultiAddRow vs InviteLinkTab), so scope to the panel.
  const invitePanel = dialog.getByRole("tabpanel", { name: "Invite link" })

  const roleLabel = invitePanel.getByText("Role", { exact: true })
  await expect(roleLabel).toBeVisible({ timeout: 3_000 })

  const roleSelect = invitePanel.getByRole("combobox", { name: "Role", exact: true })
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })

  await pickSelectOption(alice, roleSelect, /^viewer/i)
  await expectSelectValue(roleSelect, /viewer/i)

  await pickSelectOption(alice, roleSelect, /^contributor/i)
  await expectSelectValue(roleSelect, /contributor/i)
})
