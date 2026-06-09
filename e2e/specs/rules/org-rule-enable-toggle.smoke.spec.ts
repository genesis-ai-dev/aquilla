import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesSurface — org rule enable/disable toggle.
 *
 * RulesSurface.tsx renders an org-level rules section for maintainer+ users.
 * Each org rule has a Switch with aria-label:
 *   "Enable org rule: <name>" (when rule is disabled)
 *   "Disable org rule: <name>" (when rule is enabled)
 *
 * This spec: navigate to the project rules page → create an org rule →
 * verify the "Disable org rule: ..." switch appears (rule is enabled by default) →
 * click it to disable → aria-label changes to "Enable org rule: ..." →
 * click again to re-enable.
 */
test("org rule enable toggle disables and re-enables an org rule", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `OrgRuleToggle ${Date.now()}`
  await dash.createProject({ name: projName, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Create an org rule via "Add org rule" button.
  const addOrgRuleBtn = alice.getByRole("button", { name: /Add org rule|New org rule/i }).first()
  await expect(addOrgRuleBtn).toBeVisible({ timeout: 10_000 })
  await addOrgRuleBtn.click()

  const dialog = alice.getByRole("dialog").first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const ruleName = `OrgToggle ${Date.now()}`
  const nameInput = dialog.locator("#re-name").or(dialog.locator('input[placeholder*="name" i]')).first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(ruleName)

  const patInput = dialog.locator("#re-pat").or(dialog.locator('input[placeholder*="pattern" i]')).first()
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("test-org-pattern")

  const saveBtn = dialog.getByRole("button", { name: /Save|Create|Add/i }).first()
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // The org rule is now enabled. Find the "Disable org rule: ..." switch.
  const disableSwitch = alice.locator(`[aria-label="Disable org rule: ${ruleName}"]`)
  await expect(disableSwitch).toBeVisible({ timeout: 10_000 })

  // Click to disable.
  await disableSwitch.click()

  // Switch label changes to "Enable org rule: ..."
  const enableSwitch = alice.locator(`[aria-label="Enable org rule: ${ruleName}"]`)
  await expect(enableSwitch).toBeVisible({ timeout: 5_000 })

  // Re-enable.
  await enableSwitch.click()
  await expect(disableSwitch).toBeVisible({ timeout: 5_000 })
})
