import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RuleEditor — autofix "Preview on sample text" input shows before/after.
 *
 * When the autofix section is expanded in RuleEditor.tsx:
 *   - A "Find pattern" input
 *   - A "Replace with" input
 *   - A "Preview on sample text" input
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

  // Fill the autofix find pattern and replacement through their accessible labels.
  const dialog = alice.getByRole("dialog", { name: "Create translation rule" })
  const afPatInput = dialog.getByRole("textbox", { name: "Find pattern" })
  await expect(afPatInput).toBeVisible({ timeout: 5_000 })
  await afPatInput.fill("hello")

  const afReplInput = dialog.getByRole("textbox", { name: "Replace with" })
  await expect(afReplInput).toBeVisible({ timeout: 3_000 })
  await afReplInput.fill("world")

  // Type in the sample text preview input.
  const sampleInput = dialog.getByRole("textbox", { name: "Preview on sample text" })
  await expect(sampleInput).toBeVisible({ timeout: 3_000 })
  await sampleInput.fill("say hello there")

  // The "after" text should show "say world there" (green text).
  // The "before" has the original text with line-through.
  await expect(alice.getByText("say world there")).toBeVisible({ timeout: 5_000 })
})
