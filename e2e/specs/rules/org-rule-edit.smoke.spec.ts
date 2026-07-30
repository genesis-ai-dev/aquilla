import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `OrgRuleEdit ${Date.now()}`,
  })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  // Create an org rule first. "+ Add Org Rule" opens a create dialog.
  const addOrgRuleBtn = alice.getByRole("button", { name: /Add Org Rule/i }).first()
  await expect(addOrgRuleBtn).toBeVisible({ timeout: 10_000 })
  await addOrgRuleBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const ruleName = `EditRule ${Date.now()}`
  const nameInput = dialog.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill(ruleName)

  const patInput = dialog.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("edit-test-pattern")

  const saveBtn = dialog.getByRole("button", { name: /^Create rule$/ })
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  // Dialog closes after save and the new org rule row appears.
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(ruleName)).toBeVisible({ timeout: 5_000 })

  // Find the Edit pencil button for the new org rule (aria-label; AppTooltip clears title).
  const editBtn = alice.getByRole("button", { name: "Edit org rule" }).first()
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
