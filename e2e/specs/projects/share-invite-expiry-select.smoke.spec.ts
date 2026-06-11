import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * SharePanel InviteLinkTab — "Link expires" select changes value.
 *
 * SharePanel.tsx > InviteLinkTab renders a <select> labeled "Link expires"
 * with four options:
 *   - "1 day" (value=1)
 *   - "7 days (default)" (value=7, the default)
 *   - "30 days" (value=30)
 *   - "No expiry" (value=null → "null")
 *
 * This spec: open share dialog → switch to Invite link tab → verify the
 * select defaults to "7 days (default)" → change to "No expiry" → verify
 * value is "null" → change to "1 day" → verify value is "1".
 */
test("share invite expiry select changes value", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ShareExp ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // The dashboard should show the project card.
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

  // "Link expires" select is visible.
  const expirySelect = alice.locator('select').filter({ hasText: /days/ }).first()
  await expect(expirySelect).toBeVisible({ timeout: 3_000 })

  // Default is 7 days.
  await expect(expirySelect).toHaveValue("7")

  // Change to "No expiry".
  await expirySelect.selectOption("null")
  await expect(expirySelect).toHaveValue("null")

  // Change to "1 day".
  await expirySelect.selectOption("1")
  await expect(expirySelect).toHaveValue("1")
})
