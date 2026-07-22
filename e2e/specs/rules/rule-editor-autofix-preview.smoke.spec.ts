import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RuleEditor — autofix "Preview on sample text" input shows before/after.
 *
 * When the autofix section is expanded in RuleEditor.tsx:
 *   - A "Find pattern" input (placeholder="pattern")
 *   - A "Replace with" input (placeholder="replacement")
 *   - A "Preview on sample text" input (placeholder="Type sample text to see before/after…")
 * (data-autofix-field attributes belong to the rule-row AutofixEditor in
 * RulesSurface.tsx, not to RuleEditor.)
 *
 * Typing in the sample input shows:
 *   <original text (line-through)> → <replaced text (green)>
 *
 * This spec: create a rule → open autofix section → fill find/replace →
 * type sample text → verify the transformed "after" text appears.
 */
test("rule editor autofix preview shows before/after transform", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `AFPreview ${Date.now()}` })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Open the inline RuleEditor via "+ Add Rule".
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  // Fill rule name + pattern.
  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(`Preview Rule ${Date.now()}`)

  const patInput = alice.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("hello")

  // Expand the autofix section.
  const toggleAutofix = alice.getByRole("button", { name: /Add autofix/i })
  await expect(toggleAutofix).toBeVisible({ timeout: 3_000 })
  await toggleAutofix.click()

  // Fill the autofix find pattern and replacement (RuleEditor's autofix
  // inputs are identified by their literal placeholders).
  const afPatInput = alice.locator('input[placeholder="pattern"]')
  await expect(afPatInput).toBeVisible({ timeout: 5_000 })
  await afPatInput.fill("hello")

  const afReplInput = alice.locator('input[placeholder="replacement"]')
  await expect(afReplInput).toBeVisible({ timeout: 3_000 })
  await afReplInput.fill("world")

  // Type in the sample text preview input.
  const sampleInput = alice.locator('input[placeholder="Type sample text to see before/after…"]')
  await expect(sampleInput).toBeVisible({ timeout: 3_000 })
  await sampleInput.fill("say hello there")

  // The "after" text should show "say world there" (green text).
  // The "before" has the original text with line-through.
  await expect(alice.getByText("say world there")).toBeVisible({ timeout: 5_000 })
})
