import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * SharePanel — "Copy URL" button shows "Copied!" confirmation.
 *
 * After generating an invite link via the Invite link tab, SharePanel.tsx
 * shows:
 *   - A read-only input with the invite URL
 *   - A Button with title="Copy URL" (Copy icon)
 *   - After clicking: a "Copied!" confirmation paragraph appears
 *
 * This spec: creates a project → opens Share panel → generates an invite
 * link → clicks "Copy URL" → verifies "Copied!" text appears.
 */
test("share panel Copy URL button shows Copied confirmation", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CopyUrl ${Date.now()}`
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

  // Switch to Invite link tab.
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()

  // Create the link.
  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeVisible({ timeout: 5_000 })
  await createBtn.click()

  // Wait for the URL input + Copy URL button to appear.
  const copyBtn = dialog.locator('button[title="Copy URL"]')
  await expect(copyBtn).toBeVisible({ timeout: 10_000 })

  // Click Copy URL.
  await copyBtn.click()

  // "Copied!" confirmation text should appear.
  await expect(dialog.getByText(/Copied!/i)).toBeVisible({ timeout: 3_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
