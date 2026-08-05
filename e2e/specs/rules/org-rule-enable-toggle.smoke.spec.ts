import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `OrgRuleToggle ${Date.now()}`,
  })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  // Create an org rule. "+ Add Org Rule" opens a create dialog.
  const addOrgRuleBtn = alice.getByRole("button", { name: /Add Org Rule/i }).first()
  await expect(addOrgRuleBtn).toBeVisible({ timeout: 10_000 })
  await addOrgRuleBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const ruleName = `OrgToggle ${Date.now()}`
  const nameInput = dialog.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill(ruleName)

  const patInput = dialog.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("test-org-pattern")

  const saveBtn = dialog.getByRole("button", { name: /^Create rule$/ })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  // Dialog closes after save.
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
