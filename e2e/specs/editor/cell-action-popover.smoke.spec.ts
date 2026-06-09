import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cell action rail and overflow popover ("More cell actions").
 *
 * FRO-237: "Record audio" was moved from the ⋯ overflow popover to a direct
 * mic button on the CellActionRail (aria-label="Record audio"). The ⋯ popover
 * now contains "Add comment" (and other items) but NOT "Record audio".
 *
 * The rail mic button:
 *   - aria-label="Record audio" when mic is allowed
 *   - aria-label="Microphone access blocked — click for help" when denied
 *   - Always enabled (never disabled) — even when mic is denied, it routes
 *     click to the help popover instead of being dead.
 *
 * The ⋯ overflow button:
 *   - Visible when the cell has translated text, comments, audio, or a cue.
 *   - aria-label="More cell actions"
 *   - "Add comment" is always present when comments hook is wired.
 *   - "Record audio" text is NOT in the ⋯ popover anymore (FRO-237).
 */
test("cell action rail shows direct mic button by aria-label; overflow popover shows Add comment", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CellPopover ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Hover the first cell row to reveal the CellActionRail.
  const row = ws.cellRow(0)
  await row.hover()

  // FRO-237: mic is now a direct rail button on the action rail (not inside the ⋯ popover).
  // The aria-label is "Record audio" (normal) or "Microphone access blocked — click for help" (denied).
  const micRailBtn = row.locator('button[aria-label="Record audio"]')
  await expect(micRailBtn).toBeVisible({ timeout: 5_000 })

  // Click the "More cell actions" overflow button.
  const moreBtn = row.locator('button[aria-label="More cell actions"]')
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  // "Add comment" button is always present when no comments exist yet.
  await expect(alice.getByText("Add comment").first()).toBeVisible({ timeout: 3_000 })

  // Dismiss the popover by pressing Escape.
  await alice.keyboard.press("Escape")
})
