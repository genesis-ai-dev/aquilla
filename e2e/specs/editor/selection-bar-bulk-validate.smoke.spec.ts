import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SelectionBar — bulk Validate action.
 *
 * When cells are selected via the selection checkbox, the SelectionBar
 * (aria-label="Selection actions") shows a "Validate N" button.
 * Clicking it emits a validate event for each selected cell.
 * After bulk validation a success toast is shown (sonner data-sonner-toast).
 *
 * Direct human edits auto-validate. This spec removes that validation, then
 * selects the reviewed cell → clicks "Validate" in the SelectionBar → asserts
 * the success status message appears.
 */
test("SelectionBar bulk validate marks selected cells as validated", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `BulkVal ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // A direct human edit creates eligible text and auto-validates it. Remove that
  // validation first so this test exercises the bulk re-validation journey.
  await ws.editCell(0, "translated text")
  await ws.expectSelfValidated(0)
  await ws.unvalidateCell(0)

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

  // Status toast with validated count (sonner uses data-sonner-toast).
  const statusMsg = alice.locator("[data-sonner-toast]").filter({ hasText: /Validated/i }).first()
  await expect(statusMsg).toBeVisible({ timeout: 8_000 })
  await expect(ws.validationToggle(0)).toHaveAttribute("aria-pressed", "true", { timeout: 8_000 })
})
