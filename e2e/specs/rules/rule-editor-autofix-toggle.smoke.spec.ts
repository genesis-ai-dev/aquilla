import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleEditor — "Add autofix (optional)" toggle reveals/hides the autofix section.
 *
 * RuleEditor.tsx has a plain <button> below the pattern field:
 *   - Text "Add autofix (optional)" when showAutofix=false
 *   - Text "Hide autofix" when showAutofix=true
 * Clicking it toggles a collapsible "Autofix — regex replace" form with
 * "Find pattern", "Replace with", and "Flags" inputs.
 *
 * This spec: create a rule → open the inline RuleEditor (+ Add Rule) →
 * fill name + pattern → click "Add autofix (optional)" → autofix form
 * appears (label "Autofix — regex replace") → click "Hide autofix" →
 * form disappears.
 */
test("rule editor autofix toggle shows and hides autofix form", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AutofixToggle ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?(?:\?|$)/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Open the inline RuleEditor.
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  // Fill rule name (required for Save button).
  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(`Rule ${Date.now()}`)

  // Fill pattern (required for canSave).
  const patternInput = alice.locator("#re-pat")
  await expect(patternInput).toBeVisible({ timeout: 3_000 })
  await patternInput.fill("foo")

  // "Add autofix (optional)" toggle is visible, autofix form is hidden.
  const addAutofixBtn = alice.getByText(/Add autofix \(optional\)/i)
  await expect(addAutofixBtn).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByText(/Autofix — regex replace/i)).not.toBeVisible()

  // Click the toggle — autofix form appears.
  await addAutofixBtn.click()
  await expect(alice.getByText(/Autofix — regex replace/i)).toBeVisible({ timeout: 2_000 })

  // Click "Hide autofix" — form disappears.
  const hideAutofixBtn = alice.getByText(/Hide autofix/i)
  await expect(hideAutofixBtn).toBeVisible({ timeout: 2_000 })
  await hideAutofixBtn.click()
  await expect(alice.getByText(/Autofix — regex replace/i)).not.toBeVisible({ timeout: 2_000 })
})
