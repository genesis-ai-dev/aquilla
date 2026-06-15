import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * AudioRecordingModal — opens from the direct mic rail button (FRO-237).
 *
 * FRO-237: Record audio was moved from the ⋯ overflow popover to a direct
 * mic button on the CellActionRail (aria-label="Record audio"). This spec
 * opens the modal via the rail mic button directly, without going through
 * the ⋯ popover.
 *
 * The modal opens in "idle" phase and shows:
 *   - sr-only DialogTitle "Record audio — …"
 *   - Idle-state prompt "Press Space or click Start."
 *   - Close button (title="Close (Esc)")
 *
 * This spec opens the modal and verifies the idle state renders.
 * It does NOT start recording (no microphone needed for this check).
 */
test("audio recording modal opens in idle state from rail mic button", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Record ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Hover cell to reveal the action rail.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // FRO-237: click the direct rail mic button (aria-label="Record audio").
  // This replaces the old flow that opened the ⋯ popover first.
  const micRailBtn = row.locator('button[aria-label="Record audio"]')
  await expect(micRailBtn).toBeVisible({ timeout: 5_000 })
  await micRailBtn.click()

  // AudioRecordingModal opens as a Dialog.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Idle state: "Press Space or click Start."
  await expect(
    alice.getByText(/Press.*Space.*or click Start/i)
  ).toBeVisible({ timeout: 5_000 })

  // Close button.
  const closeBtn = alice.getByRole("button", { name: "Close" })
  await expect(closeBtn).toBeVisible({ timeout: 3_000 })
  await closeBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
