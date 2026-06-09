import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ExportDialog — switching export format.
 *
 * ExportDialog renders a radiogroup (aria-label="Export format") with
 * individual radio buttons (aria-label="<Format label> (<ext>)").
 * Selecting a different format updates the active radio.
 *
 * This spec: opens export dialog → verifies TSV is pre-selected →
 * selects CSV → verifies CSV radio is now checked → Export downloads .csv.
 */
test("export format switch to CSV triggers a CSV download", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ExportFmt ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open Export dialog.
  const exportBtn = alice.locator('button[aria-label="Export file"]')
  await expect(exportBtn).toBeVisible({ timeout: 5_000 })
  await exportBtn.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // TSV is pre-selected.
  const tsvRadio = dialog.locator('input[type="radio"][value="tsv"]')
  await expect(tsvRadio).toBeChecked({ timeout: 3_000 })

  // Switch to CSV.
  const csvRadio = dialog.locator('input[type="radio"][value="csv"]')
  await expect(csvRadio).toBeVisible({ timeout: 3_000 })
  await csvRadio.click()
  await expect(csvRadio).toBeChecked({ timeout: 3_000 })

  // Export → download should be a .csv file.
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 10_000 }),
    dialog.getByRole("button", { name: /^Export$/i }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.csv$/i)

  await alice.keyboard.press("Escape")
})
