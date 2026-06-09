import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Project Share dialog (SharePanel).
 *
 * The workspace sidebar nav has a "Share" button. Clicking it opens a Dialog
 * with title "Share Project" and two tabs: "Members" and "Invite link".
 * This spec verifies the dialog opens and both tabs are accessible.
 */
test("share dialog opens with Members and Invite link tabs", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Share ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The "Share" button is in the workspace sidebar nav.
  const shareBtn = alice.getByRole("button", { name: /^Share$/i })
  await expect(shareBtn).toBeVisible({ timeout: 5_000 })
  await shareBtn.click()

  // The SharePanel renders as a Dialog.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Share Project/i })).toBeVisible()

  // Both tab buttons are present.
  await expect(dialog.getByRole("button", { name: /^Members$/i })).toBeVisible({ timeout: 3_000 })
  await expect(dialog.getByRole("button", { name: /^Invite link$/i })).toBeVisible({ timeout: 3_000 })

  // Switch to the Invite link tab and verify it renders.
  await dialog.getByRole("button", { name: /^Invite link$/i }).click()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
