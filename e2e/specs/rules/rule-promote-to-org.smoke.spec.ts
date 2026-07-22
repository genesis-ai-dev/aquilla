import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RulesSurface — Promote a project rule to org scope.
 *
 * When alice (org owner with canEditOrgRules=true) is on the Rules page,
 * project rule rows show a "Promote to org" button. Clicking it opens a
 * Dialog with title "Promote rule to org?" and "Cancel" / "Promote to org"
 * action buttons.
 *
 * This spec: creates a project → creates a rule → navigates to /rules →
 * clicks "Promote to org" → dialog opens → Cancel closes it.
 */
test("Promote to org button opens confirmation dialog", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `PromoteOrg ${Date.now()}` })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Create a rule so the "Promote to org" button appears.
  const addRuleBtn = alice.getByRole("button", { name: /\+ Add Rule|New rule|Add rule/i }).first()
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const ruleName = `PromoteRule ${Date.now()}`
  const nameInput = alice.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill(ruleName)

  // Fill the regex pattern field (required).
  const patInput = alice.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("test-pattern")

  // Submit the rule.
  await alice.getByRole("button", { name: /^Create rule$/ }).click()
  await expect(alice.getByText(ruleName)).toBeVisible({ timeout: 8_000 })

  // Click "Promote to org" on the newly created rule row.
  const ruleRow = alice.locator("li, tr, div").filter({ hasText: ruleName }).first()
  await ruleRow.hover()
  const promoteBtn = ruleRow.getByRole("button", { name: /Promote to org/i })
    .or(alice.getByRole("button", { name: /Promote to org/i }))
  await expect(promoteBtn.first()).toBeVisible({ timeout: 5_000 })
  await promoteBtn.first().click()

  // Dialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /Promote rule to org/i })).toBeVisible()

  // Cancel closes the dialog.
  await dialog.getByRole("button", { name: /^Cancel$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
