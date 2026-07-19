import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Create a custom translation rule (inline RuleEditor).
 *
 * RulesSurface.tsx has a "+ Add Rule" button that opens an inline RuleEditor.
 * The editor has:
 *   - Name input (placeholder "e.g. Preserve numbers")
 *   - Description input (placeholder "Numbers in source must appear in target")
 *   - Pattern/replacement inputs
 *   - Save and Cancel buttons
 *
 * This spec verifies the inline editor appears and Cancel dismisses it.
 * Creating a complete rule is covered by the violation spec.
 */
test("add rule inline editor appears and Cancel dismisses", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AddRule ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  // "+ Add Rule" button opens the inline editor.
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  // Inline RuleEditor appears with name placeholder.
  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })

  // Description input.
  await expect(
    alice.locator('input[placeholder="Numbers in source must appear in target"]')
  ).toBeVisible({ timeout: 3_000 })

  // Cancel closes the editor.
  const cancelBtn = alice.getByRole("button", { name: /Cancel/i }).first()
  await cancelBtn.click()
  await expect(nameInput).not.toBeVisible({ timeout: 3_000 })

  // "+ Add Rule" button is back to enabled.
  await expect(addRuleBtn).toBeEnabled({ timeout: 3_000 })
})
