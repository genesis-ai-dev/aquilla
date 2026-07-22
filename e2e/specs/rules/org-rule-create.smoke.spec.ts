import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Org-level rule creation ("+ Add Org Rule").
 *
 * RulesSurface.tsx renders an "Org Rules" card when the caller is a
 * project maintainer (alice is always an org owner). The card has an
 * "+ Add Org Rule" button. Clicking it opens the inline RuleEditor
 * (same UI as + Add Rule, but creates an org-scoped rule).
 *
 * This spec: navigates to rules page → clicks "+ Add Org Rule" →
 * fills name and pattern → clicks "Create rule" → verifies the org
 * rule appears in the "Org Rules" card.
 */
test("+ Add Org Rule creates an org-scoped rule", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `OrgRuleProj ${Date.now()}`,
  })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // The "Org Rules" card and "+ Add Org Rule" button (maintainer only).
  const addOrgRuleBtn = alice.getByRole("button", { name: /\+ Add Org Rule/i })
  await expect(addOrgRuleBtn).toBeVisible({ timeout: 10_000 })
  await addOrgRuleBtn.click()

  // Inline RuleEditor opens for a new org rule.
  const ruleName = `OrgRule ${Date.now()}`
  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(ruleName)
  await alice.locator("#re-pat").fill("org-pattern")

  // Save button text is "Create rule" for new rules.
  const saveBtn = alice.getByRole("button", { name: /Create rule/i })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()

  // The org rule appears in the Org Rules card.
  await expect(alice.getByText(ruleName).first()).toBeVisible({ timeout: 5_000 })
})
