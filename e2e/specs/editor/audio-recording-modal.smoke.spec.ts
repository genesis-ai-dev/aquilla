import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AudioRecordingModal — opens from the cell action popover "Record audio" button.
 *
 * The modal opens in "idle" phase and shows:
 *   - sr-only DialogTitle "Record audio — …"
 *   - Idle-state prompt "Press Space or click Start."
 *   - Close button (title="Close (Esc)")
 *
 * This spec opens the modal and verifies the idle state renders.
 * It does NOT start recording (no microphone needed for this check).
 */
test("audio recording modal opens in idle state from cell action popover", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Record ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Hover cell to reveal the action rail, then open the popover.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // Click "More cell actions" button to open the popover.
  const moreBtn = row.locator('[aria-label="More cell actions"]')
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  // The popover is portaled to body — find "Record audio" button.
  const recordAudioBtn = alice.locator('button[title="Record audio"]')
  await expect(recordAudioBtn).toBeVisible({ timeout: 3_000 })
  await recordAudioBtn.click()

  // AudioRecordingModal opens as a Dialog.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Idle state: "Press Space or click Start."
  await expect(
    alice.getByText(/Press.*Space.*or click Start/i)
  ).toBeVisible({ timeout: 5_000 })

  // Close button.
  const closeBtn = alice.locator('[title="Close (Esc)"]')
  await expect(closeBtn).toBeVisible({ timeout: 3_000 })
  await closeBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
