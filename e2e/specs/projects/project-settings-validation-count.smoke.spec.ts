import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ValidationSettingsSection — validation count input and role floor select.
 *
 * ProjectSettings Validation card has:
 *   - Input id="validation-count" (type=number, min=1, max=15)
 *   - Base UI Select (trigger id="validation-role-floor") with options:
 *     "Reviewer (default)", "Project Lead", "Maintainer"
 *
 * This spec: navigate to project settings → scroll to Validation section →
 * change the validation count from 1 to 3 → verify the input shows 3 →
 * change the role floor to "Project Lead" → verify the trigger shows "Project Lead".
 */
test("project settings validation count and role floor can be changed", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ValCount ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // Scroll to Validation section.
  const validationSection = alice.locator("#section-validation")
  await expect(validationSection).toBeVisible({ timeout: 10_000 })
  await validationSection.scrollIntoViewIfNeeded()

  // Change the validation count input to 3.
  const countInput = alice.locator("#validation-count")
  await expect(countInput).toBeVisible({ timeout: 5_000 })
  await countInput.fill("3")
  await expect(countInput).toHaveValue("3")

  // Change the role floor select to "Project Lead".
  const roleSelect = alice.locator("#validation-role-floor")
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, roleSelect, "Project Lead")
  await expectSelectValue(roleSelect, "Project Lead")
})
