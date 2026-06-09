import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SelectionBar — Clear selection (×) button.
 *
 * When at least one cell is selected, SelectionBar renders a
 * (aria-label="Clear selection") × button. Clicking it calls clearSelection()
 * and the SelectionBar disappears.
 *
 * This spec: selects a cell → verifies SelectionBar is visible →
 * clicks "Clear selection" → SelectionBar disappears.
 */
test("SelectionBar Clear selection button dismisses the bar", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ClearSel ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Select the first cell's checkbox.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const checkbox = row.locator('input[type="checkbox"]').first()
  await expect(checkbox).toBeVisible({ timeout: 5_000 })
  await checkbox.check()

  // SelectionBar appears.
  const selBar = alice.locator('[aria-label="Selection actions"]')
  await expect(selBar).toBeVisible({ timeout: 5_000 })

  // Click "Clear selection".
  const clearBtn = selBar.getByRole("button", { name: /Clear selection/i })
  await expect(clearBtn).toBeVisible({ timeout: 3_000 })
  await clearBtn.click()

  // SelectionBar disappears.
  await expect(selBar).not.toBeVisible({ timeout: 3_000 })
})
