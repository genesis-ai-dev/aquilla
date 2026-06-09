import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * NextUnfinishedButton — "Jump to next unfinished cell (Cmd+.)"
 *
 * NextUnfinishedButton.tsx:
 *   <Button title="Jump to next unfinished cell (Cmd+.)" aria-label="Next unfinished" disabled={disabled}>
 *
 * The button is disabled when !activeFileId || !hasUnfinished.
 * When the file has at least one cell without a translation, the button
 * should be enabled. Clicking it scrolls/focuses the next empty cell.
 *
 * This spec: imports a file (all cells start empty = unfinished) → verifies
 * the "Next unfinished" button is enabled and visible → clicks it → verifies
 * the page does not error (navigation succeeded).
 */
test("Next unfinished button is enabled and clickable when cells are unfinished", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NextUnfinished ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The "Next unfinished" button should be in the toolbar.
  const nextBtn = alice.locator('[aria-label="Next unfinished"]')
  await expect(nextBtn).toBeVisible({ timeout: 8_000 })

  // It should have the title tooltip.
  await expect(nextBtn).toHaveAttribute("title", "Jump to next unfinished cell (Cmd+.)")

  // It should be enabled (cells are unfinished — no translations yet).
  await expect(nextBtn).toBeEnabled({ timeout: 5_000 })

  // Click the button — should navigate without error.
  await nextBtn.click()

  // Page should still be on the project workspace URL (no navigation away).
  await expect(alice).toHaveURL(/\/project\/[^/]+/, { timeout: 3_000 })
})
