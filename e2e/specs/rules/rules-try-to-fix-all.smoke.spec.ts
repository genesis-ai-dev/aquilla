import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesSurface — "Try to fix all" button navigates to editor with ?openRule=.
 *
 * RulesSurface.tsx renders a "Try to fix all" button per rule (title="Opens
 * the editor with this rule's drawer"). Clicking it calls:
 *   navigate(`/project/${projectId}?openRule=${rule.id}`)
 *
 * ProjectWorkspace picks up the `?openRule=` search param and sets the rule
 * drawer open for that rule.
 *
 * This spec:
 *   1. Creates a project and a rule via the Rules page.
 *   2. Navigates to /rules.
 *   3. Clicks the "Try to fix all" button.
 *   4. URL should contain `openRule=` param and we navigate to the editor.
 */
test("'Try to fix all' button navigates to editor with ?openRule= param", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TryFixAll ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Create a rule.
  const addRuleBtn = alice.getByRole("button", { name: /add rule|new rule|\+ rule/i }).first()
  await expect(addRuleBtn).toBeVisible({ timeout: 8_000 })
  await addRuleBtn.click()

  // Fill in rule name in the dialog.
  const ruleNameInput = alice.locator('input[placeholder*="rule name" i], input[aria-label*="rule name" i], input[name="name"]').first()
  await expect(ruleNameInput).toBeVisible({ timeout: 5_000 })
  await ruleNameInput.fill("test-rule")

  // Save the rule.
  const saveBtn = alice.getByRole("button", { name: /save|create|add/i }).first()
  await saveBtn.click()
  await alice.waitForTimeout(500)

  // "Try to fix all" button should appear for the new rule.
  const tryFixBtn = alice.getByRole("button", { name: /Try to fix all/i }).first()
  await expect(tryFixBtn).toBeVisible({ timeout: 8_000 })
  await tryFixBtn.click()

  // URL should contain openRule= param and be on the project editor.
  await alice.waitForURL(/\/project\/[^/]+\?.*openRule=/, { timeout: 5_000 })
  expect(alice.url()).toContain("openRule=")
})
