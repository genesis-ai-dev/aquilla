import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleEditor — "Enabled" checkbox toggles the rule's enabled state.
 *
 * RuleEditor.tsx renders a checkbox with the label "Enabled" next to the
 * severity buttons. By default it is checked (enabled=true). Unchecking it
 * disables the rule; re-checking re-enables it.
 *
 * This spec: navigate to the rules page → create a rule → open the inline
 * editor → verify "Enabled" checkbox is checked → uncheck it → verify it
 * is unchecked → re-check it → verify checked again.
 */
test("rule editor Enabled checkbox toggles", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleEnabled ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate to the project rules page.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Create a rule if none exist.
  const createBtn = alice.getByRole("button", { name: /New rule|Add rule|Create rule/i })
  await expect(createBtn).toBeVisible({ timeout: 10_000 })
  await createBtn.click()

  // Fill the rule name.
  const nameInput = alice.locator("#rname")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill("enabled-toggle-test-rule")

  // Open the inline editor (title="Edit rule").
  const editBtn = alice.locator('button[title="Edit rule"]').first()
  if (await editBtn.isVisible()) {
    await editBtn.click()
  }

  // The "Enabled" checkbox is present and checked by default.
  // Find checkbox near the "Enabled" label specifically.
  const enabledLabel = alice.getByText("Enabled", { exact: true })
  await expect(enabledLabel).toBeVisible({ timeout: 5_000 })

  // The checkbox is near the label — locate via its parent label element.
  const checkbox = alice.locator('label').filter({ hasText: /^Enabled$/ }).locator('input[type="checkbox"]')
  await expect(checkbox).toBeVisible({ timeout: 3_000 })
  await expect(checkbox).toBeChecked()

  // Uncheck it.
  await checkbox.click()
  await expect(checkbox).not.toBeChecked({ timeout: 2_000 })

  // Re-check it.
  await checkbox.click()
  await expect(checkbox).toBeChecked({ timeout: 2_000 })
})
