import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * SharePanel — UsernameTypeahead mode toggle (@user vs email).
 *
 * UsernameTypeahead.tsx has two mode-selector buttons in the members tab:
 *   - "@user" (title="Invite an existing Aquilla user") — username mode (default)
 *   - "email" (title="Invite by email — they'll be prompted to sign up if needed")
 *
 * Switching to email mode shows an email input instead of the username
 * typeahead. The active mode has a shadow-sm background style.
 *
 * This spec: opens Share → Members tab → switches to "email" mode →
 * verifies an email-type input appears → switches back to "@user" mode.
 */
test("share panel invite mode toggles between @user and email", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `InviteMode ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

  // Open Share panel.
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await expect(shareBtn).toBeVisible({ timeout: 10_000 })
  await shareBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Ensure we're on the Members tab (default).
  const membersTab = dialog.getByRole("button", { name: /^Members$/i })
  if (await membersTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await membersTab.click()
  }

  // "@user" button is visible (title="Invite an existing Aquilla user").
  const userModeBtn = dialog.locator('button[title="Invite an existing Aquilla user"]')
  await expect(userModeBtn).toBeVisible({ timeout: 10_000 })

  // "email" button is visible.
  const emailModeBtn = dialog.locator('button[title="Invite by email — they\'ll be prompted to sign up if needed"]')
    .or(dialog.getByText(/^email$/).first())
  await expect(emailModeBtn).toBeVisible({ timeout: 3_000 })

  // Switch to email mode.
  await emailModeBtn.click()

  // An email input field should appear.
  const emailInput = dialog.locator('input[type="email"]')
    .or(dialog.locator('input[placeholder*="email" i]').first())
  await expect(emailInput).toBeVisible({ timeout: 5_000 })

  // Switch back to @user mode.
  await userModeBtn.click()

  // Email input should be gone; username typeahead should appear.
  await expect(emailInput).not.toBeVisible({ timeout: 3_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
