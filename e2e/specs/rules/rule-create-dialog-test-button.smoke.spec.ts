import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { pickSelectOption } from "../../helpers/base-ui"

/**
 * RuleCreateDialog — "Test your rule" area validates the pattern inline.
 *
 * RuleCreateDialog.tsx has a "Test your rule" section at the bottom of the
 * create form. It shows:
 *   - An input with placeholder "Source text..."
 *   - An input with placeholder "Target text..."
 *   - A "Test" button (type="button")
 *   - A result span prefixed with "✓" (pass) or "✗" (fail)
 *
 * For checkType "target-forbids": handleTest() builds a regex from
 * targetPattern and tests testTarget. If the regex matches testTarget,
 * the result is "✗ Target contains forbidden pattern".
 *
 * This spec: open Rules page → click "+ Add Rule" → set type to
 * "Target forbids" → enter a forbidden pattern → enter matching target text →
 * click Test → verify "Target contains forbidden pattern" failure message.
 * Then clear the target text and re-test → verify pass message.
 */
test("rule create dialog test button shows pass/fail for target-forbids rule", async ({
  alice,
}) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RuleTest ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate to the Rules page for the new project.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Open the "Create Translation Rule" dialog.
  const addBtn = alice.getByRole("button", { name: /\+ Add Rule/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: /Create Translation Rule/i })).toBeVisible({
    timeout: 5_000,
  })

  // Fill in a rule name (required).
  await dialog.locator("#rname").fill("No articles in target")

  // Change Rule Type to "Target forbids". The dialog has two Base UI
  // Selects (combobox triggers): Severity first, then Rule Type.
  const ruleTypeSelect = dialog.getByRole("combobox").nth(1)
  await pickSelectOption(alice, ruleTypeSelect, "Target forbids")

  // The forbidden pattern input appears: placeholder="\\b(the|a|an)\\b".
  const patInput = dialog.locator("#tpat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("forbidden")

  // Fill the test target with text containing the forbidden word.
  const targetInput = dialog.locator('input[placeholder="Target text..."]')
  await expect(targetInput).toBeVisible({ timeout: 3_000 })
  await targetInput.fill("this is forbidden text")

  // Click Test.
  const testBtn = dialog.getByRole("button", { name: /^Test$/i })
  await expect(testBtn).toBeVisible({ timeout: 2_000 })
  await testBtn.click()

  // Result should be a failure: "✗ Target contains forbidden pattern".
  await expect(dialog.getByText(/Target contains forbidden pattern/i)).toBeVisible({
    timeout: 3_000,
  })

  // Clear the target input and re-test → should pass.
  await targetInput.fill("this is clean text")
  await testBtn.click()

  await expect(dialog.getByText(/✓/)).toBeVisible({ timeout: 3_000 })

  // Close without saving.
  await alice.keyboard.press("Escape")
})
