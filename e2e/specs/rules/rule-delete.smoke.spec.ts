import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RulesSurface — delete a custom rule.
 *
 * Each rule row in RulesSurface.tsx has a Trash2 icon button (ghost, sm) at
 * the right-hand side of the row. Clicking it calls `deleteRule(rule.id)`
 * which immediately removes the rule from the list.
 *
 * Lucide renders the Trash2 icon as <svg class="lucide lucide-trash-2 …">,
 * so we can find the parent <button> with `button:has(svg.lucide-trash-2)`.
 *
 * This spec:
 *   1. Creates a project and a custom rule.
 *   2. Navigates to /rules.
 *   3. Verifies the rule name is visible.
 *   4. Clicks the trash button in the rule row.
 *   5. Verifies the rule name disappears from the list.
 */
test("delete a custom rule removes it from the rules list", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `RuleDelete ${Date.now()}`,
  })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Add a custom rule via "+ Add Rule".
  const addRuleBtn = alice.getByRole("button", { name: /\+ Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const ruleName = `Delete Me ${Date.now()}`
  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill(ruleName)

  // Pattern input is #re-pat (its placeholder is the regex hint "\d+", so
  // placeholder-based locators don't match it).
  const patternInput = alice.locator("#re-pat")
  await expect(patternInput).toBeVisible({ timeout: 3_000 })
  await patternInput.fill("foo")

  const saveBtn = alice.getByRole("button", { name: /^Create rule$/ })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()

  // Rule should appear in the list.
  const ruleText = alice.getByText(ruleName)
  await expect(ruleText.first()).toBeVisible({ timeout: 5_000 })

  // Click the trash button — Lucide Trash2 renders as svg.lucide-trash-2.
  // Only one custom rule exists, so the first trash button in the custom
  // rules section is the one for our rule.
  const deleteBtn = alice.locator('button:has(svg.lucide-trash-2)').first()
  await expect(deleteBtn).toBeVisible({ timeout: 5_000 })
  await deleteBtn.click()

  // Rule row disappears.
  await expect(ruleText.first()).not.toBeVisible({ timeout: 5_000 })
})
