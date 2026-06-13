import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesSurface — "+ Add Rule" inline editor creates a rule and adds it to
 * the list.
 *
 * The rules surface refactor replaced the RuleCreateDialog with an inline
 * RuleEditor rendered at the top of the rules surface. The header
 * "+ Add Rule" button opens it (and disables itself while it is open).
 * The editor contains:
 *   - Input#re-name (Rule name, required)
 *   - Input#re-desc (Description, optional)
 *   - Mode / Side / Severity button groups
 *   - Input#re-pat (Pattern, required)
 *   - "Create rule" submit button (disabled until name + valid pattern)
 *
 * This spec: navigate to /project/:id/rules → click "+ Add Rule" → verify
 * the inline editor opens and "Create rule" is disabled until both name and
 * pattern are filled → submit → editor closes → new rule name appears in
 * the rules list.
 */
test("Add Rule inline editor creates and displays new rule", async ({ alice }) => {
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

  // The inline RuleEditor opens with a "New rule" header, and the header
  // "+ Add Rule" button disables while it is open.
  await expect(alice.getByText("New rule", { exact: true })).toBeVisible({ timeout: 5_000 })
  await expect(addRuleBtn).toBeDisabled()

  // Fill the Rule name input.
  const nameInput = alice.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const ruleName = `no-numbers-${Date.now()}`
  await nameInput.fill(ruleName)

  // "Create rule" stays disabled until a valid pattern is also provided.
  const createBtn = alice.getByRole("button", { name: /^Create rule$/ })
  await expect(createBtn).toBeDisabled()
  await alice.locator("#re-pat").fill("\\d+")
  await expect(createBtn).toBeEnabled({ timeout: 2_000 })
  await createBtn.click()

  // Editor closes.
  await expect(alice.getByText("New rule", { exact: true })).not.toBeVisible({
    timeout: 5_000,
  })

  // New rule name appears in the rules list.
  await expect(alice.getByText(ruleName)).toBeVisible({ timeout: 5_000 })
})
