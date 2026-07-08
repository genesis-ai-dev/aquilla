import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectCreateDialog — "Advanced: project shape" details section.
 *
 * ProjectCreateDialog.tsx renders a <details> element labeled
 * "Advanced: project shape" with a Base UI RadioGroup (role="radio" items,
 * not native inputs):
 *   - Self-contained (default)
 *   - Source-only
 *   - Linked target
 *
 * The section is collapsed by default. Clicking the <summary> opens it,
 * revealing the radio buttons. Selecting "Source-only" checks that radio.
 *
 * This spec: open the "+ New Project" dialog → expand "Advanced: project
 * shape" details → verify three radio items visible → select "Source-only"
 * → verify it is checked → select "Self-contained" → verify it is checked.
 */
test("project create dialog advanced shape section toggles radio buttons", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const dialog = await dash.openCreateProjectDialog()

  // Click the "Advanced: project shape" summary to expand the details.
  const advancedSummary = dialog.locator("summary").filter({ hasText: /Advanced.*project shape/i })
  await expect(advancedSummary).toBeVisible({ timeout: 3_000 })
  await advancedSummary.click()

  // Three radio items (Base UI role="radio") should now be visible.
  const radios = dialog.getByRole("radio")
  await expect(radios).toHaveCount(3, { timeout: 3_000 })

  // Self-contained is checked by default.
  const selfContainedRadio = radios.nth(0)
  await expect(selfContainedRadio).toBeChecked()

  // Click "Source-only" label.
  const sourceOnlyLabel = dialog.locator("label").filter({ hasText: /Source-only/i })
  await expect(sourceOnlyLabel).toBeVisible({ timeout: 2_000 })
  await sourceOnlyLabel.click()

  const sourceOnlyRadio = radios.nth(1)
  await expect(sourceOnlyRadio).toBeChecked()
  await expect(selfContainedRadio).not.toBeChecked()

  // Click back to "Self-contained".
  const selfContainedLabel = dialog.locator("label").filter({ hasText: /Self-contained/i })
  await selfContainedLabel.click()
  await expect(selfContainedRadio).toBeChecked()

  // Close without submitting.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
