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

  // Create an org rule first. "+ Add Org Rule" opens an INLINE RuleEditor
  // inside the Org Rules card (no dialog — rules refactor 0f70ff11f).
  const addOrgRuleBtn = alice.getByRole("button", { name: /Add Org Rule/i }).first()
  await expect(addOrgRuleBtn).toBeVisible({ timeout: 10_000 })
  await addOrgRuleBtn.click()

  const ruleName = `EditRule ${Date.now()}`
  const nameInput = alice.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill(ruleName)

  const patInput = alice.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("edit-test-pattern")

  const saveBtn = alice.getByRole("button", { name: /^Create rule$/ })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  // Editor closes after save and the new org rule row appears.
  await expect(nameInput).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(ruleName)).toBeVisible({ timeout: 5_000 })

  // Find the Edit pencil button for the new org rule.
  const editBtn = alice.locator(`[data-tooltip="Edit org rule"]`).first()
  await expect(editBtn).toBeVisible({ timeout: 10_000 })

  // Click to open inline editor.
  await editBtn.click()

  // Inline RuleEditor should be visible — it contains the pattern input,
  // pre-filled with the rule's existing pattern (edit mode).
  const inlineEditor = alice.locator("#re-pat")
  await expect(inlineEditor).toBeVisible({ timeout: 5_000 })
  await expect(inlineEditor).toHaveValue("edit-test-pattern")

  // Click Edit button again to collapse the editor.
  await editBtn.click()
  await expect(inlineEditor).not.toBeVisible({ timeout: 3_000 })
})
