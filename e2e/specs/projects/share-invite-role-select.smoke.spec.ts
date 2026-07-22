import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SharePanel InviteLinkTab — "Role" select changes the link's granted role.
 *
 * SharePanel.tsx > InviteLinkTab renders a Base UI Select whose trigger has
 * aria-label="Role", with LINK_ROLE_OPTIONS labels: "viewer" (100),
 * "commenter" (200), "reviewer" (300), "contributor" (400). The description
 * paragraph below it updates when the selection changes.
 *
 * This spec: open the share dialog → switch to Invite link tab → verify
 * the Role select is present → change to viewer → verify the trigger shows
 * "viewer" → change to contributor → verify it shows "contributor".
 */
test("share invite role select changes the link role", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `InvRole ${Date.now()}` })

  // Enter the workspace — the sidebar "More project options" menu (which
  // hosts Share) only exists there, not on the org home.
  await openSeededProject(alice, seeded)

  // Open the share dialog from the sidebar "More" menu.
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i }).first()
  await expect(shareBtn).toBeVisible({ timeout: 10_000 })
  await shareBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Switch to Invite link tab (plain buttons, not role=tab).
  const inviteTab = dialog.getByRole("button", { name: /Invite link/i })
  await expect(inviteTab).toBeVisible({ timeout: 5_000 })
  await inviteTab.click()

  // "Role" label and select trigger are visible.
  const roleLabel = dialog.getByText("Role", { exact: true })
  await expect(roleLabel).toBeVisible({ timeout: 3_000 })

  const roleSelect = dialog.getByRole("combobox", { name: "Role", exact: true })
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })

  // Change to viewer (100).
  await pickSelectOption(alice, roleSelect, /^viewer$/i)
  await expectSelectValue(roleSelect, /viewer/i)

  // Change to contributor (400).
  await pickSelectOption(alice, roleSelect, /^contributor$/i)
  await expectSelectValue(roleSelect, /contributor/i)
})
