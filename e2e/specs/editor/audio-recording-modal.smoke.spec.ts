import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * AudioRecordingModal — opens from the direct mic rail button (AQU-237).
 *
 * AQU-237: Record audio was moved from the ⋯ overflow popover to a direct
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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Record ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Hover cell to reveal the action rail.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // AQU-237: click the direct rail mic button (aria-label="Record audio").
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
