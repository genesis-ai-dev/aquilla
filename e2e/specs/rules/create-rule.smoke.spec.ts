import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Create a custom translation rule (dialog RuleEditor).
 *
 * RulesSurface.tsx has a "+ Add Rule" button that opens a create dialog
 * wrapping RuleEditor. The editor has:
 *   - Name input (placeholder "e.g. Preserve numbers")
 *   - Description input (placeholder "Numbers in source must appear in target")
 *   - Pattern/replacement inputs
 *   - Save and Cancel buttons
 *
 * This spec verifies the create dialog appears and Cancel dismisses it.
 * Creating a complete rule is covered by the violation spec.
 */
test("add rule create dialog appears and Cancel dismisses", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AddRule ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  // "+ Add Rule" button opens the create dialog.
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })

  // RuleEditor appears with name placeholder.
  const nameInput = dialog.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })

  // Description input.
  await expect(
    dialog.locator('input[placeholder="Numbers in source must appear in target"]')
  ).toBeVisible({ timeout: 3_000 })

  // Cancel closes the dialog.
  const cancelBtn = dialog.getByRole("button", { name: /Cancel/i }).first()
  await cancelBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })

  // "+ Add Rule" button is back to enabled.
  await expect(addRuleBtn).toBeEnabled({ timeout: 3_000 })
})
