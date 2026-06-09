import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * BuiltinChecksList — toggle a built-in rule enabled/disabled.
 *
 * Each built-in rule row has a checkbox (type="checkbox")
 * aria-label="${def.name} enabled". Unchecking disables the rule;
 * re-checking enables it.
 *
 * This spec: navigates to rules page → finds "Extra whitespace enabled"
 * checkbox → verifies it's checked → unchecks it → re-checks to restore.
 */
test("builtin rule enabled checkbox toggles the rule on and off", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BuiltinToggle ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Find the "Extra whitespace enabled" checkbox.
  const enabledCheckbox = alice.locator('input[type="checkbox"][aria-label="Extra whitespace enabled"]')
  await expect(enabledCheckbox).toBeVisible({ timeout: 10_000 })

  // Should be checked (enabled by default).
  await expect(enabledCheckbox).toBeChecked({ timeout: 3_000 })

  // Uncheck to disable.
  await enabledCheckbox.uncheck()
  await expect(enabledCheckbox).not.toBeChecked({ timeout: 3_000 })

  // Re-check to re-enable.
  await enabledCheckbox.check()
  await expect(enabledCheckbox).toBeChecked({ timeout: 3_000 })
})
