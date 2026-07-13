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
 * Bulk validate only counts cells that are eligible AND not already validated
 * by the current user (isBulkValidationEligible + !activeValidators.includes).
 * A direct human edit now AUTO-VALIDATES the cell for the editor
 * (EditorTable.tsx, "Auto validate on human edit"), so a freshly edited cell
 * is already validated and would make the button disabled ("Nothing eligible").
 * To exercise bulk Validate we therefore first edit the cell (auto-validates),
 * then remove that validation so the cell becomes a translated, human-touched,
 * not-yet-validated-by-me cell — the state bulk Validate is built for.
 *
 * This spec: edit cell 0 → remove the auto-validation → select cell 0 →
 * click "Validate" in the SelectionBar → assert the success status message.
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

  // Edit the first cell to give it a non-empty translation (required to
  // validate). This auto-validates the cell for alice.
  await ws.editCell(0, "translated text")

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()

  // Remove alice's auto-validation so the cell is eligible for bulk Validate
  // (mirrors validation/cell-unvalidate.smoke.spec.ts). Click the already-
  // validated indicator to open the popover, then the trash button. Wait for
  // aria-pressed="false" so the removal has fully round-tripped before we
  // rely on the SelectionBar seeing an unvalidated cell.
  await row.hover()
  const healthBtn = row.getByRole("button", { name: /Validated/i }).first()
  await expect(healthBtn).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 })
  await healthBtn.click()
  const removeBtn = alice.locator('[data-tooltip="Remove your validation"] button, button[aria-label="Remove your validation"]')
  await expect(removeBtn).toBeVisible({ timeout: 8_000 })
  await removeBtn.click()
  await expect(healthBtn).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 })

  // Select the first cell via its selection checkbox.
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
