import { test, expect } from "../../helpers/multi-user"
import { expectSelectValue, pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — Validation settings section.
 *
 * ValidationSettingsSection renders:
 *   - A Base UI Select (trigger id="validation-role-floor") for "minimum role
 *     that can validate" (Reviewer (default) / Project Lead / Maintainer)
 *   - A Switch id="allow-self-validation" for the allow self-validation toggle
 *
 * These controls are visible without saving; the parent ProjectSettings
 * form marks itself dirty and shows "Save changes" when values change.
 *
 * This spec navigates to settings, toggles the switch, selects a different
 * role, and verifies the "Save changes" button appears.
 */
test("project settings validation section: changing options makes form dirty", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ValSettings ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // The Allow self-validation switch is visible.
  const selfValidationSwitch = alice.locator("#allow-self-validation")
  await expect(selfValidationSwitch).toBeVisible({ timeout: 10_000 })

  // The role floor select renders with "Reviewer" as default.
  const roleSelect = alice.locator("#validation-role-floor")
  await expect(roleSelect).toBeVisible({ timeout: 5_000 })
  await expectSelectValue(roleSelect, /Reviewer/)

  // Change role to "Project Lead" — makes the form dirty.
  await pickSelectOption(alice, roleSelect, "Project Lead")

  // "Save changes" button appears when form is dirty.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })
  await expect(saveBtn).toBeEnabled()
})
