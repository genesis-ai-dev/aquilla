import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Use the VTT fixture — subtitle files expose "Attach video" in the overflow menu.
const VTT_FIXTURE = path.resolve(__dirname, "../../fixtures/voices-roundtrip.vtt")

/**
 * VideoAttachmentDialog — "Attach video" option in the workspace overflow menu.
 *
 * The WorkspaceHeader has an OverflowMenu (aria-label="More") that contains
 * "Attach video" when a subtitle file (VTT/SRT) is open.
 * Clicking it opens VideoAttachmentDialog with DialogTitle "Attach Video".
 *
 * This spec imports a VTT, opens the overflow menu, and verifies the dialog.
 */
test("attach video dialog opens from overflow menu for VTT file", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Video ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(VTT_FIXTURE)
  await ws.openFileBySubstring("voices-roundtrip")
  await ws.waitForEditor()

  // The WorkspaceHeader OverflowMenu button.
  const moreBtn = alice.getByRole("button", { name: /^More$/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  // "Attach video" item is visible in the dropdown (only for subtitle files).
  // No .or() text fallback: when the menu is open BOTH branches match (the
  // menuitem and its inner label span), which is a strict-mode violation.
  const attachVideoItem = alice.getByRole("menuitem", { name: /Attach video/i })
  await expect(attachVideoItem).toBeVisible({ timeout: 3_000 })
  await attachVideoItem.click()

  // VideoAttachmentDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Attach Video/i })).toBeVisible()

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
