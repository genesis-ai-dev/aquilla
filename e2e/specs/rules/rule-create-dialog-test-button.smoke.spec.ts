import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * RuleEditor — live preview evaluates the draft rule against real cells.
 *
 * The old RuleCreateDialog "Test your rule" area was retired with the rules
 * surface refactor (RulesPage/RuleCreateDialog are no longer routed). Its
 * replacement is the inline RuleEditor's "Live preview — current file"
 * section (RuleEditor.tsx): while drafting a rule, the editor runs the
 * draft check against the currently-open file's cells and reports either
 * "N cell(s) would be flagged" (fail/match) or "No matches in the current
 * file." (pass/no match).
 *
 * The preview runs against project cells loaded by the settings pane.
 * After committing a cell in the editor, navigate to /settings/rules (the
 * pane fetches cells from the server — it does not need the editor shell).
 *
 * This spec: import a file → put a forbidden word in cell 0's target →
 * open Rules in project settings → "+ Add Rule" → default mode is
 * Forbidden/Target → enter the forbidden pattern → live preview flags the
 * cell. Then switch to a non-matching pattern → preview reports no matches.
 */
test("rule editor live preview shows pass/fail for target-forbids rule", async ({
  alice,
}) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `RuleTest ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Put the forbidden word into cell 0's target text.
  await ws.editCell(0, "this is forbidden text")

  await alice.goto(`/project/${seeded.projectId}/settings/rules`)

  // Open the inline RuleEditor. Default mode is Forbidden + Target, which
  // maps to a target-forbids check.
  const addBtn = alice.getByRole("button", { name: /Add Rule/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  await alice.locator("#re-name").fill("No articles in target")

  // Enter a pattern that matches cell 0's target → live preview flags it.
  const patInput = alice.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 3_000 })
  await patInput.fill("forbidden")

  // "1 cell would be flagged" and the preview section appear (debounced
  // ~300ms after typing).
  await expect(alice.getByText(/1 cell would be flagged/i)).toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(/Live preview — current file/i)).toBeVisible()

  // Switch to a pattern that matches nothing → preview reports a pass.
  await patInput.fill("zzz_never_matches_zzz")
  await expect(alice.getByText(/No matches in the current file/i)).toBeVisible({
    timeout: 5_000,
  })

  // Close the editor without saving.
  await alice.getByRole("button", { name: /^Cancel$/ }).last().click()
  await expect(alice.locator("#re-pat")).not.toBeVisible({ timeout: 3_000 })
})
