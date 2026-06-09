import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Edit an existing translation rule via the inline RuleEditor.
 *
 * RulesSurface.tsx: each rule row has a Pencil "Edit rule" button
 * (title="Edit rule"). Clicking it opens the inline RuleEditor pre-filled
 * with the rule's current values.
 *
 * This spec: creates a custom rule → clicks "Edit rule" → verifies the
 * RuleEditor opens with the rule name pre-filled → Cancel closes it.
 */
test("edit rule button opens inline RuleEditor pre-filled with rule name", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EditRule ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Create a new rule first.
  const addRuleBtn = alice.getByRole("button", { name: /\+ Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const ruleName = `TestRule ${Date.now()}`
  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(ruleName)

  // Fill pattern (id="re-pat") to satisfy canSave.
  const patternInput = alice.locator("#re-pat")
  await expect(patternInput).toBeVisible({ timeout: 3_000 })
  await patternInput.fill("foo")

  // Save the rule — button text is "Create rule" for new rules.
  const saveBtn = alice.getByRole("button", { name: /Create rule/i })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()

  // Wait for rule to appear in the list.
  await expect(alice.getByText(ruleName).first()).toBeVisible({ timeout: 5_000 })

  // Click "Edit rule" Pencil button.
  const editBtn = alice.locator('[title="Edit rule"]').first()
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
