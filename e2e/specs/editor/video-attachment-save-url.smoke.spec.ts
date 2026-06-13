import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VTT_FIXTURE = path.resolve(__dirname, "../../fixtures/voices-roundtrip.vtt")

/**
 * VideoAttachmentDialog — fills episode title + video URL and saves.
 *
 * VideoAttachmentDialog.tsx has:
 *   - Episode title input (placeholder="Episode 1")
 *   - Video URL input (type="url")
 *   - "Save URL" button (disabled while URL is empty; enabled once URL is filled)
 *
 * This spec: open the dialog → type a title + URL → verify "Save URL" is
 * enabled and click it → verify the dialog closes.
 */
test("video attachment dialog Save URL enables after entering a URL", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `VideoURL ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(VTT_FIXTURE)
  await ws.openFileBySubstring("voices-roundtrip")
  await ws.waitForEditor()

  // Open overflow menu → Attach video.
  const moreBtn = alice.getByRole("button", { name: /^More$/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  // No .or() text fallback: when the menu is open BOTH branches match (the
  // menuitem and its inner label span), which is a strict-mode violation.
  const attachVideoItem = alice.getByRole("menuitem", { name: /Attach video/i })
  await expect(attachVideoItem).toBeVisible({ timeout: 3_000 })
  await attachVideoItem.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // With no attachment saved, the dialog defaults to the "Upload file" tab
  // (tab = current.videoUrl ? "url" : "upload") — switch to "From URL" to
  // reach the URL + display-name inputs. Retry the click: a dialog remount
  // right after open can swallow the first tab switch (observed: button
  // focused but the upload panel still rendered).
  const titleInput = dialog.locator('input[placeholder="Episode 1"]')
  await expect(async () => {
    await dialog.getByRole("button", { name: /From URL/i }).click()
    await expect(titleInput).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await titleInput.fill("Test Episode")

  // URL input starts empty; "Save URL" button should be disabled.
  const saveUrlBtn = dialog.getByRole("button", { name: /Save URL/i })
  await expect(saveUrlBtn).toBeDisabled()

  // Fill a URL — the input is #vurl (it carries no type="url" attribute).
  const urlInput = dialog.locator("#vurl")
  await expect(urlInput).toBeVisible({ timeout: 3_000 })
  await urlInput.fill("https://example.com/video.mp4")

  // "Save URL" should now be enabled.
  await expect(saveUrlBtn).toBeEnabled({ timeout: 3_000 })

  // Click Save URL — dialog should close.
  await saveUrlBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
})
