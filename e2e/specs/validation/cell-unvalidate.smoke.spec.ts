import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Individual cell unvalidation via Health button popover.
 *
 * EditorTable.tsx: when a cell is validated by the current user, opening
 * the validation popover shows a trash button with title="Remove your
 * validation". Clicking it calls emitValidationChange(false) which removes
 * the validation, and the health button title reverts to the unvalidated state.
 *
 * This spec:
 *   1. Create a project → import → edit + validate cell 0.
 *   2. Hover the health button again (now shows "— validated").
 *   3. Open the validation popover (click the health button, don't Space-press —
 *      clicking with mouse opens the popover without toggling state).
 *   4. Click "Remove your validation" trash button.
 *   5. Verify the health button title no longer contains "validated".
 */
test("cell Remove your validation button removes the validation", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Unvalidate ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)
  await ws.editCell(0, "Translation to validate then remove")
  await ws.validateCell(0)

  // Validation button now reports validated state through aria-pressed.
  const row = ws.cellRow(0)
  await row.hover()
  const healthBtn = row.getByRole("button", { name: /Validated/i }).first()
  await expect(healthBtn).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 })

  // Open the validation popover with the documented pointer interaction.
  // Clicking an already-validated indicator opens details; unlike hover-open,
  // this remains deterministic when the full smoke suite is under load.
  await healthBtn.click()

  // "Remove your validation" trash button should appear inside the popover.
  const removeBtn = alice.locator('[data-tooltip="Remove your validation"] button, button[aria-label="Remove your validation"]')
  await expect(removeBtn).toBeVisible({ timeout: 8_000 })

  // Click to remove the validation.
  await removeBtn.click()

  // Validation state should no longer be pressed. Like
  // Workspace.validateCell, allow 15s for the sync round-trip (IDB →
  // sync-worker → D1 → push back) under load.
  await expect(healthBtn).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 })
})
