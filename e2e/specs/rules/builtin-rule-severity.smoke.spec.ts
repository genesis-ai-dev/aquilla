import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * BuiltinChecksList — change a built-in rule's severity.
 *
 * RulesPage renders BuiltinChecksList. Each built-in rule row has a
 * native <select> with aria-label="<rule name> severity" and options
 * "Major" / "Minor".
 *
 * This spec: navigates to the rules page → finds "Extra whitespace severity"
 * select → changes it from "major" to "minor" → verifies the select value
 * updated → changes it back to "major".
 */
test("builtin rule severity select changes from major to minor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Severity ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Find the "Extra whitespace" severity select.
  const severitySelect = alice.locator('select[aria-label="Extra whitespace severity"]')
  await expect(severitySelect).toBeVisible({ timeout: 10_000 })

  // Default value should be "major".
  await expect(severitySelect).toHaveValue("major")

  // Change to "minor".
  await severitySelect.selectOption("minor")
  await expect(severitySelect).toHaveValue("minor")

  // Restore to "major".
  await severitySelect.selectOption("major")
  await expect(severitySelect).toHaveValue("major")
})
