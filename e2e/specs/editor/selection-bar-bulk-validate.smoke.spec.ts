import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SelectionBar — bulk Validate action.
 *
 * When cells are selected via the selection checkbox, the SelectionBar
 * (aria-label="Selection actions") shows a "Validate N" button.
 * Clicking it emits a validate event for each selected cell.
 * After bulk validation a success toast is shown (role="status").
 *
 * This spec: selects the first cell → clicks "Validate" in the SelectionBar
 * → asserts the success status message appears.
 */
test("SelectionBar bulk validate marks selected cells as validated", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BulkVal ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Edit the first cell to give it a non-empty translation (required to validate).
  await ws.editCell(0, "translated text")

  // Select the first cell via its selection checkbox.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const selCheckbox = row.getByRole("checkbox", { name: /Select cell/i })
  await expect(selCheckbox).toBeVisible({ timeout: 3_000 })
  await selCheckbox.click()

  // SelectionBar appears.
  const bar = alice.locator('[aria-label="Selection actions"]')
  await expect(bar).toBeVisible({ timeout: 3_000 })

  // Validate button.
  const validateBtn = bar.getByRole("button", { name: /Validate/i })
  await expect(validateBtn).toBeVisible({ timeout: 3_000 })
  await expect(validateBtn).toBeEnabled({ timeout: 3_000 })
  await validateBtn.click()

  // Status toast with validated count.
  const statusMsg = alice.locator('[role="status"]').filter({ hasText: /Validated/i }).first()
  await expect(statusMsg).toBeVisible({ timeout: 8_000 })
})
