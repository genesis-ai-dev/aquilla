import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesSurface — "+ Add Rule" create dialog creates a rule and adds it to
 * the list.
 *
 * The in-main toolbar "+ Add Rule" button opens a dialog wrapping RuleEditor
 * (and disables itself while it is open). The editor contains:
 *   - Input#re-name (Rule name, required)
 *   - Input#re-desc (Description, optional)
 *   - Mode / Side / Severity button groups
 *   - Input#re-pat (Pattern, required)
 *   - "Create rule" submit button (stays enabled; validates on click)
 *
 * This spec: navigate to /project/:id/rules → click "+ Add Rule" → verify
 * the create dialog opens → click Create with missing fields shows errors →
 * fill name + pattern → submit → dialog closes → new rule appears.
 */
test("Add Rule create dialog creates and displays new rule", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleDialog ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await dash.openProject(name)
  await alice.waitForURL(/\/project\/[^/]+/)
  const projectUrl = alice.url()
  const match = projectUrl.match(/\/project\/([^/]+)/)
  const projectId = match ? match[1] : ""

  await alice.goto(`/project/${projectId}/rules`)
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText("New rule", { exact: true })).toBeVisible({ timeout: 5_000 })

  const createBtn = dialog.getByRole("button", { name: /^Create rule$/ })
  await expect(createBtn).toBeEnabled()
  await createBtn.click()
  await expect(dialog.getByText(/rule name is required/i)).toBeVisible({ timeout: 2_000 })

  const nameInput = dialog.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  const ruleName = `no-numbers-${Date.now()}`
  await nameInput.fill(ruleName)

  await createBtn.click()
  await expect(dialog.getByText(/pattern is required/i)).toBeVisible({ timeout: 2_000 })

  await dialog.locator("#re-pat").fill("\\d+")
  await createBtn.click()

  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  await expect(addRuleBtn).toBeEnabled({ timeout: 3_000 })

  await expect(alice.getByText(ruleName)).toBeVisible({ timeout: 5_000 })
})
