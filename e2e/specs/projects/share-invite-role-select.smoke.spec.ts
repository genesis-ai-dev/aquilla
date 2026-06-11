import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * SharePanel InviteLinkTab — "Role" select changes the link's granted role.
 *
 * SharePanel.tsx > InviteLinkTab renders a <select> labeled "Role" with
 * LINK_ROLE_OPTIONS: Viewer (100), Commenter (200), Reviewer (300),
 * Contributor (400). The description paragraph below it updates when the
 * selection changes.
 *
 * This spec: open the share dialog → switch to Invite link tab → verify
 * the Role select is present → change to Viewer → verify value is "100" →
 * change to Contributor → verify value is "400".
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

  // "Role" label and select are visible.
  const roleLabel = alice.getByText("Role", { exact: true })
  await expect(roleLabel).toBeVisible({ timeout: 3_000 })

  // Find the Role select — it's above the expiry select, so it's the first <select>.
  // (The expiry select is labeled "Link expires" and is second.)
  const roleSelect = alice.locator('select').first()
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })

  // Change to Viewer (100).
  await roleSelect.selectOption("100")
  await expect(roleSelect).toHaveValue("100")

  // Change to Contributor (400).
  await roleSelect.selectOption("400")
  await expect(roleSelect).toHaveValue("400")
})
