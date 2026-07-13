import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cell action rail — direct icon buttons (no ⋯ overflow popover).
 *
 * AQU-237: mic is a direct rail button (aria-label="Record audio").
 * Comments, TTS, and play-audio are also direct rail icons; the down-caret
 * opens the expanded row panel for lower-frequency actions.
 */
test("cell action rail shows direct mic and Add comment buttons", async ({ alice }) => {
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

  const micRailBtn = row.locator('button[aria-label="Record audio"]')
  await expect(micRailBtn).toBeVisible({ timeout: 5_000 })

  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
})
