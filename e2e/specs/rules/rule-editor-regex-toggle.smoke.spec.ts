import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RuleEditor — "Switch to literal text" / "Switch to regex" toggle.
 *
 * RuleEditor.tsx has a button next to the Pattern input that toggles
 * between regex and literal-text mode:
 *   - Default mode: regex → button text "Switch to literal text"
 *   - After clicking: literal → button text "Switch to regex"
 *   - After clicking again: back to regex → "Switch to literal text"
 *
 * In literal mode, a hint "Treated as literal text (auto-escaped)" appears
 * below the pattern input when text is typed.
 *
 * This spec: open RuleEditor → verify regex mode → click "Switch to literal
 * text" → verify button changes to "Switch to regex" → click again → reverts.
 */
test("rule editor regex/literal toggle switches pattern mode", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RegexToggle ${Date.now()}` })
  await alice.goto(`/project/${seeded.projectId}/rules`)
  // Open inline RuleEditor.
  const addRuleBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  // Default mode is regex — button says "Switch to literal text".
  const switchBtn = alice.getByText(/Switch to literal text/i)
  await expect(switchBtn).toBeVisible({ timeout: 3_000 })

  // Click → switches to literal mode → button says "Switch to regex".
  await switchBtn.click()
  await expect(alice.getByText(/Switch to regex/i)).toBeVisible({ timeout: 2_000 })
  // "Switch to literal text" should be gone.
  await expect(alice.getByText(/Switch to literal text/i)).not.toBeVisible({ timeout: 2_000 })

  // Click again → back to regex.
  await alice.getByText(/Switch to regex/i).click()
  await expect(alice.getByText(/Switch to literal text/i)).toBeVisible({ timeout: 2_000 })
})
