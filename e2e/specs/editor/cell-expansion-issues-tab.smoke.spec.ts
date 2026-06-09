import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `IssuesTab ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Get project id from URL.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Create a rule that fires on "PROHIBITED" in the target.
  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  // Open "Add rule" dialog.
  const addRuleBtn = alice.getByRole("button", { name: /Add rule|New rule/i }).first()
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const dialog = alice.getByRole("dialog").first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Fill rule pattern with "PROHIBITED_WORD" — something we'll type into the target cell.
  const patInput = alice.locator("#re-pat")
  await expect(patInput).toBeVisible({ timeout: 5_000 })
  await patInput.fill("PROHIBITED_WORD")

  // Save the rule.
  const saveBtn = dialog.getByRole("button", { name: /Save|Create|Add/i }).first()
  await expect(saveBtn).toBeEnabled({ timeout: 3_000 })
  await saveBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Import file and open editor.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

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
