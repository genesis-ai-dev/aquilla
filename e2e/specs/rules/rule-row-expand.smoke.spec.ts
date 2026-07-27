import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesPage — rule row expand/collapse chevron reveals AutofixEditor.
 *
 * RulesPage.tsx renders each rule row with a chevron button (ChevronDown/Up)
 * that toggles `expanded`. When expanded, the AutofixEditor section appears
 * with a "Save autofix" button and a [data-autofix-field="pattern"] input.
 *
 * This spec: navigate to /project/:id/rules → create a rule → click the
 * chevron to expand it → "Save autofix" button appears → click chevron
 * again to collapse → "Save autofix" disappears.
 */
test("rule row chevron expands and collapses autofix editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleExpand ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1] ?? ""

  await alice.goto(`/project/${projectId}/rules`)
  // Create a rule first.
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(`ExpandTest ${Date.now()}`)
  await alice.locator("#re-pat").fill("foo")

  const createBtn = alice.getByRole("button", { name: /Create rule/i })
  await expect(createBtn).toBeEnabled({ timeout: 3_000 })
  await createBtn.click()

  // Rule appears in list. The AutofixEditor is collapsed (no "Save autofix" visible).
  await expect(alice.getByRole("button", { name: /Save autofix/i })).not.toBeVisible({ timeout: 3_000 })

  // Click the chevron to expand the rule row.
  const ruleListItem = alice.locator("li").filter({ has: alice.getByText(/ExpandTest/i) }).first()
  await expect(ruleListItem).toBeVisible({ timeout: 5_000 })

  // The expand toggle has no accessible name — locate it by its Lucide
  // chevron icon (ChevronDown when collapsed, ChevronUp when expanded).
  const expandChevron = ruleListItem
    .locator("button:has(svg.lucide-chevron-down), button:has(svg.lucide-chevron-up)")
    .first()
  await expect(expandChevron).toBeVisible({ timeout: 3_000 })
  await expandChevron.click()

  // AutofixEditor appears with "Save autofix" button and pattern input.
  await expect(alice.getByRole("button", { name: /Save autofix/i })).toBeVisible({ timeout: 3_000 })

  // Click chevron again to collapse.
  await expandChevron.click()
  await expect(alice.getByRole("button", { name: /Save autofix/i })).not.toBeVisible({ timeout: 3_000 })
})
