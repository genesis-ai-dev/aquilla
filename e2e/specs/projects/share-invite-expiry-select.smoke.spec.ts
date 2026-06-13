import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * SharePanel InviteLinkTab — "Link expires" select changes value.
 *
 * SharePanel.tsx > InviteLinkTab renders a Base UI Select whose trigger has
 * aria-label="Link expires", with four options:
 *   - "1 day" (value=1)
 *   - "7 days" (value=7)
 *   - "30 days (default)" (value=30, the default)
 *   - "No expiry" (value=null → "null")
 *
 * This spec: open share dialog → switch to Invite link tab → verify the
 * select defaults to "30 days (default)" → change to "No expiry" → verify
 * the trigger shows "No expiry" → change to "1 day" → verify "1 day".
 */
test("share invite expiry select changes value", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ShareExp ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Enter the workspace — the sidebar "More project options" menu (which
  // hosts Share) only exists there, not on the org home.
  await dash.openProject(name)

  // Open the share dialog from the sidebar "More" menu.
  await alice.getByRole("button", { name: /More project options/i }).click()
  const shareBtn = alice.getByRole("button", { name: /^Share$/i }).first()
  await expect(shareBtn).toBeVisible({ timeout: 10_000 })
  await shareBtn.click()

  // Switch to Invite link tab (plain buttons, not role=tab).
  const inviteTab = alice.getByRole("dialog").getByRole("button", { name: /Invite link/i })
  await expect(inviteTab).toBeVisible({ timeout: 5_000 })
  await inviteTab.click()

  // "Link expires" select trigger is visible.
  const expirySelect = alice.getByRole("combobox", { name: "Link expires" })
  await expect(expirySelect).toBeVisible({ timeout: 3_000 })

  // Default is 30 days.
  await expectSelectValue(expirySelect, "30 days (default)")

  // Change to "No expiry".
  await pickSelectOption(alice, expirySelect, "No expiry")
  await expectSelectValue(expirySelect, "No expiry")

  // Change to "1 day".
  await pickSelectOption(alice, expirySelect, "1 day")
  await expectSelectValue(expirySelect, "1 day")
})
