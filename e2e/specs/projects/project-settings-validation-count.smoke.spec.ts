import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ValidationSettingsSection — validation count input and role floor select.
 *
 * ProjectSettings Validation card has:
 *   - Input id="validation-count" (type=number, min=1, max=15)
 *   - Select id="validation-role-floor" with options:
 *     "reviewer" (default), "project_lead", "maintainer"
 *
 * This spec: navigate to project settings → scroll to Validation section →
 * change the validation count from 1 to 3 → verify the input shows 3 →
 * change the role floor to "project_lead" → verify the select shows "project_lead".
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

  // Change the role floor select to "project_lead".
  const roleSelect = alice.locator("#validation-role-floor")
  await expect(roleSelect).toBeVisible({ timeout: 3_000 })
  await roleSelect.selectOption("project_lead")
  await expect(roleSelect).toHaveValue("project_lead")
})
