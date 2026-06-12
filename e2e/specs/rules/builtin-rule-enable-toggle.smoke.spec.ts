import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * BuiltinChecksList — toggle a built-in rule enabled/disabled.
 *
 * Each built-in rule row has a shadcn Switch (role="switch")
 * aria-label="${def.name} enabled". Toggling off disables the rule;
 * toggling back on enables it.
 *
 * This spec: navigates to rules page → finds "Extra whitespace enabled"
 * switch → verifies it's on → toggles it off → toggles back on to restore.
 */
test("builtin rule enabled switch toggles the rule on and off", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BuiltinToggle ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Find the "Extra whitespace enabled" switch.
  const enabledSwitch = alice.getByRole("switch", { name: "Extra whitespace enabled" })
  await expect(enabledSwitch).toBeVisible({ timeout: 10_000 })

  // Should be on (enabled by default).
  await expect(enabledSwitch).toHaveAttribute("aria-checked", "true", { timeout: 3_000 })

  // Toggle off to disable.
  await enabledSwitch.click()
  await expect(enabledSwitch).toHaveAttribute("aria-checked", "false", { timeout: 3_000 })

  // Toggle back on to re-enable.
  await enabledSwitch.click()
  await expect(enabledSwitch).toHaveAttribute("aria-checked", "true", { timeout: 3_000 })
})
