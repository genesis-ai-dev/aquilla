import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cell action popover ("More cell actions").
 *
 * Each cell row has a MoreHorizontal (⋯) button with aria-label
 * "More cell actions". Clicking it opens a Base UI Popover that contains:
 *  - "Record audio" row (CellAudioRecordButton + label)
 *  - "Add comment" button (when onOpenComments is wired — always true in workspace)
 *
 * The button renders only when:
 *   hasAudio || onOpenRecording || cell.translated.length > 0 || onOpenComments
 * Both onOpenRecording and onOpenComments are always wired in ProjectWorkspace,
 * so the button is present regardless of cell content.
 *
 * The button lives inside the CellActionRail (opacity: 0 when not hovered).
 * We hover the row first to reveal the rail before clicking.
 */
test("cell action popover opens and shows Record audio + Add comment items", async ({ alice }) => {
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

  // Click the "More cell actions" button.
  const moreBtn = row.locator('button[aria-label="More cell actions"]')
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  // The popover should appear somewhere on the page (Base UI portals it to body).
  // "Record audio" text appears as a label next to the record button.
  await expect(alice.getByText("Record audio").first()).toBeVisible({ timeout: 5_000 })

  // "Add comment" button is always present when no comments exist yet.
  await expect(alice.getByText("Add comment").first()).toBeVisible({ timeout: 3_000 })

  // Dismiss the popover by pressing Escape.
  await alice.keyboard.press("Escape")
})
