import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleDrawer — opening via the ?openRule= URL param.
 *
 * RulesPage renders a "Open in editor" Button (title="Opens the editor with
 * this rule's drawer") for each rule. Clicking it navigates to:
 *   /project/<id>?openRule=<ruleId>
 *
 * ProjectWorkspace reads `searchParams.get("openRule")` and opens the
 * RuleDrawer panel (w-80 side panel with the rule name as an h3).
 *
 * This spec: creates a rule → clicks the "Opens the editor" button →
 * verifies the RuleDrawer shows the rule name as an h3.
 */
test("RuleDrawer opens from rules page button showing rule name", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleDrawer ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Create a rule via + Add Rule.
  const addBtn = alice.getByRole("button", { name: /\+ Add Rule/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const ruleName = `DrawerRule ${Date.now()}`
  const nameInput = alice.locator('input[placeholder="e.g. Preserve numbers"]')
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(ruleName)
  await alice.locator("#re-pat").fill("test-pattern")
  await alice.getByRole("button", { name: /Create rule/i }).click()
  await expect(alice.getByText(ruleName).first()).toBeVisible({ timeout: 5_000 })

  // Click the "Opens the editor with this rule's drawer" button.
  const openEditorBtn = alice.locator(`[title="Opens the editor with this rule's drawer"]`).first()
  await expect(openEditorBtn).toBeVisible({ timeout: 5_000 })
  await openEditorBtn.click()

  // RuleDrawer opens — rule name appears as an h3 in the drawer.
  await alice.waitForURL(/\/project\/[^/]+\?openRule=/, { timeout: 5_000 })
  const drawer = alice.locator("h3").filter({ hasText: ruleName })
  await expect(drawer).toBeVisible({ timeout: 8_000 })
})
