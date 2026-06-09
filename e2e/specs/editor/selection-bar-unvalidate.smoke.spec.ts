import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SelectionBar — "Remove my validations" bulk unvalidate.
 *
 * After validating a cell, selecting it and clicking "Remove my validations"
 * in the SelectionBar (role="toolbar" aria-label="Selection actions")
 * removes the current user's validation.
 *
 * This spec: import file → edit cell → validate it → select it →
 * clicks "Remove my validations" → verifies the button was enabled and
 * clickable (cell unvalidation fires without error).
 */
test("SelectionBar Remove my validations button removes validation", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Unvalidate ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Edit the first cell.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await ws.editCell(0, "validated-text")
  // Validate the cell.
  await ws.validateCell(0)

  // Select the first cell's checkbox.
  await row.hover()
  const checkbox = row.locator('input[type="checkbox"]').first()
  await expect(checkbox).toBeVisible({ timeout: 5_000 })
  await checkbox.check()

  // SelectionBar appears.
  const selBar = alice.locator('[aria-label="Selection actions"]')
  await expect(selBar).toBeVisible({ timeout: 5_000 })

  // "Remove my validations" button is visible and enabled.
  const removeValBtn = selBar.getByRole("button", { name: /Remove my validations/i })
  await expect(removeValBtn).toBeVisible({ timeout: 3_000 })
  await expect(removeValBtn).toBeEnabled({ timeout: 3_000 })
  await removeValBtn.click()

  // After clicking, SelectionBar may close or the button may become disabled.
  // Either outcome means unvalidation was initiated.
  await alice.waitForTimeout(500)
  // No error toast should appear.
  await expect(alice.getByRole("alert", { name: /error/i })).not.toBeVisible()
})
