import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Rule enable/disable toggle (custom user rule).
 *
 * RulesSurface.tsx renders a Checkbox for each custom rule:
 *   aria-label="Enable rule: <name>" or "Disable rule: <name>"
 *
 * This spec: creates a rule → verifies its checkbox is checked (enabled) →
 * unchecks it (disables) → aria-label updates to "Enable rule: <name>".
 */
test("custom rule enable/disable toggle updates aria-label", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const projectName = `ToggleRule ${Date.now()}`
  await dash.createProject({ name: projectName })
  await dash.openProject(projectName)

  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  // Create a custom rule.
  const addBtn = alice.getByRole("button", { name: /\+ Add Rule/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const ruleName = `ToggleRule ${Date.now()}`
  await alice.locator('input[placeholder="e.g. Preserve numbers"]').fill(ruleName)
  await alice.locator("#re-pat").fill("foo")
  await alice.getByRole("button", { name: /Create rule/i }).click()
  await expect(alice.getByText(ruleName).first()).toBeVisible({ timeout: 5_000 })

  // The rule checkbox should now be visible and checked (enabled by default).
  const enabledCheckbox = alice.locator(`[aria-label="Disable rule: ${ruleName}"]`)
  await expect(enabledCheckbox).toBeVisible({ timeout: 5_000 })
  await expect(enabledCheckbox).toBeChecked()

  // Uncheck (disable).
  await enabledCheckbox.click()

  // aria-label flips to "Enable rule: <name>".
  const disabledCheckbox = alice.locator(`[aria-label="Enable rule: ${ruleName}"]`)
  await expect(disabledCheckbox).toBeVisible({ timeout: 5_000 })
  await expect(disabledCheckbox).not.toBeChecked()
})
