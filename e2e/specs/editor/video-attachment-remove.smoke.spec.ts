import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VTT_FIXTURE = path.resolve(__dirname, "../../fixtures/voices-roundtrip.vtt")

/**
 * VideoAttachmentDialog — "Remove attachment" button.
 *
 * VideoAttachmentDialog.tsx line 136:
 *   <Button variant="ghost" size="sm" onClick={handleRemove} title="Remove attachment">
 *
 * This button appears in a "Currently attached" section only when
 * `currentLabel` is non-empty (i.e., a video URL was previously saved).
 *
 * Flow:
 *   1. Open the dialog → fill title + URL → click "Save URL" → dialog closes.
 *   2. Re-open the same dialog.
 *   3. The "Currently attached" section should show with title={currentLabel}.
 *   4. The "Remove attachment" trash button is visible.
 *   5. Click it — the "Currently attached" section disappears.
 *
 * KNOWN APP GAP (test.fixme): video-attachment persistence is deliberately
 * stubbed out — ProjectWorkspace.tsx ~line 901: `const videoAttachment = {}` /
 * `const saveVideo = () => {}` ("Phase 2c-gamma: video attachments lived on
 * Y.Doc meta… comes back via the event grammar in v1.x"). Save URL silently
 * discards, so re-opening never shows "Currently attached". Un-fixme this
 * spec when video attachments are re-wired through the event grammar.
 */
test.fixme("video attachment Remove attachment button clears the saved URL", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VideoRemove ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(VTT_FIXTURE)
  await ws.openFileBySubstring("voices-roundtrip")
  await ws.waitForEditor()

  // Helper: open the Attach Video dialog.
  const openAttachVideoDialog = async () => {
    const moreBtn = alice.getByRole("button", { name: /^More$/i })
    await expect(moreBtn).toBeVisible({ timeout: 10_000 })
    await moreBtn.click()
    const attachVideoItem = alice.getByRole("menuitem", { name: /Attach video/i })
      .or(alice.getByText(/Attach video/i).first())
    await expect(attachVideoItem).toBeVisible({ timeout: 3_000 })
    await attachVideoItem.click()
    const dialog = alice.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  // Step 1: Attach a video URL.
  const dialog = await openAttachVideoDialog()
  const titleInput = dialog.locator('input[placeholder="Episode 1"]')
  await titleInput.fill("Test Episode")
  const urlInput = dialog.locator('input[type="url"]')
  await urlInput.fill("https://example.com/video.mp4")
  const saveUrlBtn = dialog.getByRole("button", { name: /Save URL/i })
  await expect(saveUrlBtn).toBeEnabled({ timeout: 3_000 })
  await saveUrlBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Step 2: Re-open the dialog.
  const dialog2 = await openAttachVideoDialog()

  // Step 3: "Currently attached" section with Remove attachment button.
  const removeBtn = dialog2.locator('[data-tooltip="Remove attachment"] button, button[aria-label="Remove attachment"]')
  await expect(removeBtn).toBeVisible({ timeout: 5_000 })

  // Also verify the currently-attached label text is shown.
  await expect(dialog2.getByText("Currently attached")).toBeVisible({ timeout: 3_000 })

  // Step 4: Click Remove attachment.
  await removeBtn.click()

  // "Currently attached" section should disappear.
  await expect(dialog2.getByText("Currently attached")).not.toBeVisible({ timeout: 3_000 })
  // The Remove button itself should be gone.
  await expect(removeBtn).not.toBeVisible({ timeout: 3_000 })
})
