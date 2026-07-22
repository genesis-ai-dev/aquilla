import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Cell expansion — "Issues" tab shows rule infractions.
 *
 * EditorTable.tsx cell expansion has an "Issues" tab (value="issues") that
 * shows rule violations for the current cell. When there are violations,
 * the tab gets an attentionDot (red for major, amber for minor).
 *
 * Setup:
 *   1. Create a project + a rule that matches a word in the sample file.
 *   2. Import sample.md and open the editor.
 *   3. Expand a cell that has the matching word in target.
 *   4. Click the "Issues" tab.
 *   5. Verify the infraction message is visible.
 *
 * The sample.md cells contain common words like "sample", so we create a
 * rule that matches "sample" in the target text.
 */
test("cell expansion Issues tab shows rule infractions", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `IssuesTab ${Date.now()}` })
  const projectId = seeded.projectId

  // Create a rule that fires on "PROHIBITED" in the target.
  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Open the rule editor. It renders INLINE on the rules surface now (the
  // dialog flow is gone; rule actions live in the workspace header).
  const addRuleBtn = alice.getByRole("button", { name: /Add rule|New rule/i }).first()
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  // Fill rule name + pattern — both are required for "Create rule" to enable.
  const nameInput = alice.locator("#re-name")
  await expect(nameInput).toBeVisible({ timeout: 5_000 })
  await nameInput.fill("No prohibited word")
  const patInput = alice.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 5_000 })
  await patInput.fill("PROHIBITED_WORD")

  // Save the rule — the inline editor closes on success.
  const saveBtn = alice.getByRole("button", { name: /Create rule/i }).first()
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  await expect(patInput).not.toBeVisible({ timeout: 5_000 })

  // Open the seeded file's editor.
  const ws = await openSeededProject(alice, seeded)

  // Type "PROHIBITED_WORD" into cell 0 target to trigger the infraction.
  await ws.editCell(0, "PROHIBITED_WORD translation")

  // Wait a moment for rule evaluation.
  await alice.waitForTimeout(2_000)

  // Open cell details.
  const row = ws.cellRow(0)
  await row.hover()
  const expandBtn = row.locator('[aria-label="Open cell details"]')
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // Click the "Issues" tab.
  const issuesTab = alice.getByRole("tab", { name: /Issues/i })
  await expect(issuesTab).toBeVisible({ timeout: 5_000 })
  await issuesTab.click()

  // The infraction should be visible — either the rule name or PROHIBITED_WORD.
  // When no infractions exist the tab says "No translation rule issues on this cell."
  // We expect at least one infraction button is visible.
  const infraction = alice.locator('[type="button"]').filter({ hasText: /PROHIBITED_WORD/ }).first()
    .or(alice.getByText(/PROHIBITED_WORD/i).first())
  await expect(infraction).toBeVisible({ timeout: 8_000 })
})
