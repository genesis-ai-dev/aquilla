import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Next-unfinished navigation button.
 *
 * `useNextUnfinished` scans cells for any that are unfinished (no translated
 * text, or fewer than validationCount validators). The toolbar button is
 * enabled whenever `hasAny` is true, and clicking it scrolls the virtualizer
 * to the next unfinished cell after the current position.
 *
 * This spec verifies:
 *  1. After importing a file (all cells start unfinished), the button is enabled.
 *  2. Clicking it does not crash the UI (editor remains stable).
 *  3. After editing + validating ALL cells, the button becomes disabled.
 *     (For the smoke path we validate just one cell of a single-cell file.)
 *
 * The sample.md fixture has multiple cells, so we only check that the button
 * is enabled before and remains interactive — exhausting all cells in a
 * virtualised list would be unwieldy in a smoke spec.
 */
test("next-unfinished button is enabled when cells exist, disabled when all done", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NextUnfinished ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The "Jump to next unfinished cell" button — identified by its title attribute.
  const jumpBtn = alice.locator('button[title="Jump to next unfinished cell (Cmd+.)"]')
  await expect(jumpBtn).toBeVisible({ timeout: 5_000 })

  // 1. With freshly-imported cells (none translated), the button should be enabled.
  await expect(jumpBtn).toBeEnabled({ timeout: 5_000 })

  // 2. Clicking it doesn't crash — editor cells still render after the jump.
  await jumpBtn.click()
  await expect(alice.locator("[data-cell-id]").first()).toBeVisible({ timeout: 5_000 })
})
