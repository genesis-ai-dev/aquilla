import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"
import { pickSelectOption, expectSelectValue } from "../../helpers/base-ui"

/**
 * BuiltinChecksList — change a built-in rule's severity.
 *
 * The RulesSurface renders BuiltinChecksList. Each built-in rule row has a
 * Base UI Select (role="combobox" trigger) with
 * aria-label="<rule name> severity" and options "Major" / "Minor".
 *
 * "Extra whitespace" (double-space) has defaultSeverity "minor" in
 * src/lib/lqa/builtin-registry.ts.
 *
 * This spec: navigates to the rules page → finds "Extra whitespace severity"
 * select → verifies the default is "Minor" → changes it to "Major" →
 * verifies the trigger label updated → changes it back to "Minor".
 */
test("builtin rule severity select changes from minor to major", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Severity ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Find the "Extra whitespace" severity select trigger.
  const severitySelect = alice.getByRole("combobox", { name: "Extra whitespace severity" })
  await expect(severitySelect).toBeVisible({ timeout: 10_000 })

  // Default value should be "Minor" (registry defaultSeverity).
  await expectSelectValue(severitySelect, "Minor")

  // Change to "Major".
  await pickSelectOption(alice, severitySelect, "Major")
  await expectSelectValue(severitySelect, "Major")

  // Restore to "Minor".
  await pickSelectOption(alice, severitySelect, "Minor")
  await expectSelectValue(severitySelect, "Minor")
})
