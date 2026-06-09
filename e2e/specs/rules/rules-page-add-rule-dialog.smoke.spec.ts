import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesPage — "+ Add Rule" dialog creates a rule and adds it to the list.
 *
 * RulesPage.tsx renders <RuleCreateDialog onAdd={addRule} /> which opens
 * a Dialog with a form containing:
 *   - Input#rname (Rule Name)
 *   - Input#rdesc (Description)
 *   - Severity select
 *   - Rule Type select
 *   - Pattern input (for source-target-match)
 *   - "Create Rule" submit button (disabled until name filled)
 *
 * This spec: navigate to /project/:id/rules → click "+ Add Rule" →
 * verify dialog opens → fill Rule Name → "Create Rule" becomes enabled →
 * submit → dialog closes → new rule name appears in the rules list.
 */
test("RulesPage Add Rule dialog creates and displays new rule", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleDialog ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate to the rules page.
  // Open the project first to get the id from URL.
  await dash.openProject(name)
  await alice.waitForURL(/\/project\/[^/]+/)
  const projectUrl = alice.url()
  const match = projectUrl.match(/\/project\/([^/]+)/)
  const projectId = match ? match[1] : ""

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Click "+ Add Rule" button.
  const addRuleBtn = alice.getByRole("button", { name: /\+ Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  // Dialog opens with "Create Translation Rule" title.
  await expect(alice.getByRole("heading", { name: /Create Translation Rule/i })).toBeVisible({
    timeout: 5_000,
  })

  // Fill the Rule Name input.
  const nameInput = alice.locator("#rname")
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const ruleName = `no-numbers-${Date.now()}`
  await nameInput.fill(ruleName)

  // "Create Rule" button becomes enabled.
  const createBtn = alice.getByRole("button", { name: /^Create Rule$/i })
  await expect(createBtn).toBeEnabled({ timeout: 2_000 })
  await createBtn.click()

  // Dialog closes.
  await expect(alice.getByRole("heading", { name: /Create Translation Rule/i })).not.toBeVisible({
    timeout: 5_000,
  })

  // New rule name appears in the rules list.
  await expect(alice.getByText(ruleName)).toBeVisible({ timeout: 5_000 })
})
