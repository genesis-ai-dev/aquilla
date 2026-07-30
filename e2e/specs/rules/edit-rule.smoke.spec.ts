import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Edit an existing translation rule via the inline RuleEditor.
 *
 * RulesSurface.tsx: each rule row has a Pencil "Edit rule" button
 * (aria-label="Edit rule"). Clicking it opens the inline RuleEditor
 * pre-filled with the rule's current values. Create still uses a dialog.
 *
 * This spec: creates a custom rule via the create dialog → clicks
 * "Edit rule" → verifies the inline RuleEditor opens with the rule name
 * pre-filled → Cancel closes it.
 */
test("edit rule button opens inline RuleEditor pre-filled with rule name", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `EditRule ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  // Create a new rule first via the create dialog.
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 3_000 })

  const ruleName = `TestRule ${Date.now()}`
  const nameInput = dialog.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(ruleName)

  // Fill pattern (id="re-pat") to satisfy canSave.
  const patternInput = dialog.locator("#re-pat")
  await expect(patternInput).toBeVisible({ timeout: 3_000 })
  await patternInput.fill("foo")

  // Save the rule — button text is "Create rule" for new rules.
  const saveBtn = dialog.getByRole("button", { name: /Create rule/i })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Wait for rule to appear in the list.
  await expect(alice.getByText(ruleName).first()).toBeVisible({ timeout: 5_000 })

  // Click "Edit rule" Pencil button (aria-label; AppTooltip clears native title).
  const editBtn = alice.getByRole("button", { name: "Edit rule" }).first()
  await expect(editBtn).toBeVisible({ timeout: 5_000 })
  await editBtn.click()

  // Inline RuleEditor opens with the rule name pre-filled.
  const editNameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(editNameInput).toBeVisible({ timeout: 3_000 })
  await expect(editNameInput).toHaveValue(ruleName, { timeout: 3_000 })

  // Cancel closes the editor.
  const cancelBtn = alice.getByRole("button", { name: /Cancel/i }).first()
  await cancelBtn.click()
  await expect(editNameInput).not.toBeVisible({ timeout: 3_000 })
})
