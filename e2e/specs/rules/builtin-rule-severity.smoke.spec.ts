import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { pickSelectOption, expectSelectValue } from "../../helpers/base-ui"

/**
 * BuiltinChecksList — change a built-in rule's severity.
 *
 * RulesPage renders BuiltinChecksList. Each built-in rule row has a
 * Base UI Select (role="combobox" trigger) with
 * aria-label="<rule name> severity" and options "Major" / "Minor".
 *
 * This spec: navigates to the rules page → finds "Extra whitespace severity"
 * select → changes it from "Major" to "Minor" → verifies the trigger label
 * updated → changes it back to "Major".
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

  // Find the "Extra whitespace" severity select trigger.
  const severitySelect = alice.getByRole("combobox", { name: "Extra whitespace severity" })
  await expect(severitySelect).toBeVisible({ timeout: 10_000 })

  // Default value should be "Major".
  await expectSelectValue(severitySelect, "Major")

  // Change to "Minor".
  await pickSelectOption(alice, severitySelect, "Minor")
  await expectSelectValue(severitySelect, "Minor")

  // Restore to "Major".
  await pickSelectOption(alice, severitySelect, "Major")
  await expectSelectValue(severitySelect, "Major")
})
