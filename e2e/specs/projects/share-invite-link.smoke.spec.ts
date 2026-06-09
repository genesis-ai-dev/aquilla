import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Share panel — Invite link tab.
 *
 * The Invite link tab (InviteLinkTab) has:
 *   - "Create invite link" button
 *   - Optional recipient email input (#invite-email)
 *   - Role selector and expiry options
 *
 * After clicking "Create invite link", the link is generated and a
 * copy button appears.
 *
 * This spec verifies the Invite link tab renders the create form and
 * creates a link.
 */
test("share panel invite link tab creates a link", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `InviteLink ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open Share panel.
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await shareBtn.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Switch to Invite link tab.
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()

  // "Create invite link" button is visible.
  const createBtn = dialog.getByRole("button", { name: /Create invite link/i })
  await expect(createBtn).toBeVisible({ timeout: 3_000 })
  await expect(createBtn).toBeEnabled()

  // Optional email input is present.
  await expect(dialog.locator("#invite-email")).toBeVisible({ timeout: 3_000 })

  // Create the link.
  await createBtn.click()

  // After creation a copy button or link URL appears.
  // The link was created — either a "Copy" button or the URL text appears.
  await expect(
    dialog.getByRole("button", { name: /Copy/i })
      .or(dialog.getByText(/\/join\//i).first())
  ).toBeVisible({ timeout: 10_000 })

  // Dismiss.
  await alice.keyboard.press("Escape")
})
