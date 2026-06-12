import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * RuleEditor — "Enabled" switch toggles the rule's enabled state.
 *
 * RuleEditor.tsx renders a shadcn Switch (role="switch") with the label
 * "Enabled" next to the severity buttons. By default it is on
 * (enabled=true). Toggling it off disables the rule; toggling back on
 * re-enables it.
 *
 * This spec: navigate to the rules page → create a rule → open the inline
 * editor → verify "Enabled" switch is on → toggle it off → verify it is
 * off → toggle it back on → verify on again.
 */
test("rule editor Enabled switch toggles", async ({ alice }) => {
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

  // The "Enabled" switch is present and on by default.
  // Find the switch near the "Enabled" label specifically.
  const enabledLabel = alice.getByText("Enabled", { exact: true })
  await expect(enabledLabel).toBeVisible({ timeout: 5_000 })

  // The switch is near the label — locate via its parent label element.
  const enabledSwitch = alice.locator('label').filter({ hasText: /^Enabled$/ }).getByRole("switch")
  await expect(enabledSwitch).toBeVisible({ timeout: 3_000 })
  await expect(enabledSwitch).toHaveAttribute("aria-checked", "true")

  // Toggle it off.
  await enabledSwitch.click()
  await expect(enabledSwitch).toHaveAttribute("aria-checked", "false", { timeout: 2_000 })

  // Toggle it back on.
  await enabledSwitch.click()
  await expect(enabledSwitch).toHaveAttribute("aria-checked", "true", { timeout: 2_000 })
})
