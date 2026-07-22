import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RuleEditor — Mode selector buttons toggle the rule type and show/hide
 * the source pattern input.
 *
 * RuleEditor.tsx renders three mode buttons: "Forbidden", "Required",
 * "Must match". When "Required" is selected, an additional source-pattern
 * input (#re-src-pat) appears ("Source pattern — when source contains this…").
 * When "Forbidden" or "Must match" is selected, that input is hidden.
 *
 * This spec: open RuleEditor → verify default "Forbidden" mode → click
 * "Required" → source-pattern input appears → click "Must match" → source-
 * pattern input disappears.
 */
test("rule editor mode selector toggles source pattern input visibility", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ModeToggle ${Date.now()}` })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Open inline RuleEditor.
  const addRuleBtn = alice.getByRole("button", { name: /\+ Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  // Default mode is "Forbidden" — source-pattern input should not be visible.
  await expect(alice.locator("#re-src-pat")).not.toBeVisible()

  // Click "Required" mode.
  const requiredBtn = alice.getByText(/^Required$/i)
  await expect(requiredBtn).toBeVisible({ timeout: 3_000 })
  await requiredBtn.click()

  // Source-pattern input appears.
  const srcPatInput = alice.locator("#re-src-pat")
  await expect(srcPatInput).toBeVisible({ timeout: 2_000 })

  // Click "Must match" mode — source-pattern input disappears.
  const mustMatchBtn = alice.getByText(/^Must match$/i)
  await expect(mustMatchBtn).toBeVisible({ timeout: 2_000 })
  await mustMatchBtn.click()
  await expect(srcPatInput).not.toBeVisible({ timeout: 2_000 })
})
