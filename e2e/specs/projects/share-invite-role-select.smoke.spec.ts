import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `InvRole ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate back to dashboard where the project card is shown.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  await alice.goto("/")
  await alice.waitForLoadState("networkidle")

  // Open the share dialog from the project card.
  // Share lives in the sidebar "More" menu (sidebar cleanup).
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i }).first()
  await expect(shareBtn).toBeVisible({ timeout: 10_000 })
  await shareBtn.click()

  // Switch to Invite link tab.
  const inviteTab = alice.getByRole("tab", { name: /Invite link/i })
  await expect(inviteTab).toBeVisible({ timeout: 5_000 })
  await inviteTab.click()

  // "Role" label and select trigger are visible.
  const roleLabel = alice.getByText("Role", { exact: true })
  await expect(roleLabel).toBeVisible({ timeout: 3_000 })

  const roleSelect = alice.getByRole("combobox", { name: "Role", exact: true })
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })

  // Change to viewer (100).
  await pickSelectOption(alice, roleSelect, /^viewer$/i)
  await expectSelectValue(roleSelect, /viewer/i)

  // Change to contributor (400).
  await pickSelectOption(alice, roleSelect, /^contributor$/i)
  await expectSelectValue(roleSelect, /contributor/i)
})
