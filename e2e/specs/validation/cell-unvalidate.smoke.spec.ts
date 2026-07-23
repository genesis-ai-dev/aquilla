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
  await ws.unvalidateCell(0)

  await expect(ws.validationToggle(0)).toHaveAttribute("aria-pressed", "false")
})
