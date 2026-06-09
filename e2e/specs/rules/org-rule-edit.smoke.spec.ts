import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RulesSurface — "Edit org rule" inline editor.
 *
 * When canEditOrgRules=true (org owner/maintainer), each org rule row has
 * a pencil button with title="Edit org rule". Clicking it toggles an inline
 * RuleEditor below the row (editingOrgRuleId switches to that rule's id).
 * Clicking the pencil again collapses the editor.
 *
 * This spec:
 *   1. Creates a project + org rule.
 *   2. Clicks the Edit pencil button.
 *   3. Verifies the inline RuleEditor becomes visible (contains a pattern input).
 *   4. Clicks the pencil again to collapse it.
 */
test("org rule edit pencil opens and closes inline RuleEditor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `OrgRuleEdit ${Date.now()}`
  await dash.createProject({ name: projName, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Create an org rule first.
  const addOrgRuleBtn = alice.getByRole("button", { name: /Add org rule|New org rule/i }).first()
  await expect(addOrgRuleBtn).toBeVisible({ timeout: 10_000 })
  await addOrgRuleBtn.click()

  const dialog = alice.getByRole("dialog").first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const ruleName = `EditRule ${Date.now()}`
  const nameInput = dialog.locator("#re-name").or(dialog.locator('input[placeholder*="name" i]')).first()
  await expect(nameInput).toBeVisible({ timeout: 3_000 })
  await nameInput.fill(ruleName)

  const patInput = dialog.locator("#re-pat").or(dialog.locator('input[placeholder*="pattern" i]')).first()
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("edit-test-pattern")

  const saveBtn = dialog.getByRole("button", { name: /Save|Create|Add/i }).first()
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Find the Edit pencil button for the new org rule.
  const editBtn = alice.locator(`button[title="Edit org rule"]`).first()
  await expect(editBtn).toBeVisible({ timeout: 10_000 })

  // Click to open inline editor.
  await editBtn.click()

  // Inline RuleEditor should be visible — it contains a pattern input field.
  const inlineEditor = alice.locator('[data-autofix-field="pattern"]')
    .or(alice.locator('#re-pat'))
    .or(alice.locator('input[placeholder*="pattern" i]').first())
  await expect(inlineEditor).toBeVisible({ timeout: 5_000 })

  // Click Edit button again to collapse the editor.
  await editBtn.click()
  await expect(inlineEditor).not.toBeVisible({ timeout: 3_000 })
})
