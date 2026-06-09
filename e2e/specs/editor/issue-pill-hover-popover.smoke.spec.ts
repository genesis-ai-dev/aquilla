import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Issue pill hover popover — EditorTable cell number pill with rule violations.
 *
 * When a cell has rule infractions, EditorTable renders a Popover around the
 * number/label pill button (aria-label="N issue(s)"). Hovering it opens a
 * PopoverContent listing each rule violation with its name and severity dot.
 *
 * This spec:
 *   1. Creates a rule that matches "sample" in the target text.
 *   2. Imports sample.md (first cell source contains "sample").
 *   3. Opens the editor — the first cell source is "sample"-containing text
 *      (no translation yet, so target is empty, but the rule fires on the
 *      source-side check). We type "sample" into the target cell to trigger
 *      the violation.
 *   4. Hovers the pill button (aria-label*="issue").
 *   5. Verifies the popover appears showing the rule name.
 */
test("hovering the issue pill popover shows rule infraction details", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `IssuePill ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Create a rule that fires on "BADWORD" in the target.
  await alice.goto(`/project/${projectId}/rules`)
  await alice.waitForLoadState("networkidle")

  const addRuleBtn = alice.getByRole("button", { name: /Add rule|New rule/i }).first()
  await expect(addRuleBtn).toBeVisible({ timeout: 10_000 })
  await addRuleBtn.click()

  const dialog = alice.getByRole("dialog").first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Fill pattern
  const patternInput = dialog.locator('input[placeholder*="pattern" i], input[name*="pattern" i]').first()
  await expect(patternInput).toBeVisible({ timeout: 3_000 })
  await patternInput.fill("BADWORD")

  // Fill rule name
  const nameInput = dialog.locator('input[placeholder*="name" i], input[name*="name" i]').first()
  if (await nameInput.isVisible()) {
    await nameInput.fill("No bad words")
  }

  const saveBtn = dialog.getByRole("button", { name: /Save|Add|Create/i }).last()
  await saveBtn.click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Navigate to workspace and import the file.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.waitForEditor()

  // Type "BADWORD" into the first cell's target editor to trigger the rule.
  const firstRow = await ws.cellRow(0)
  const targetCell = firstRow.locator('[data-cell-type="target"], [data-slot="target"]').first()
  if (await targetCell.isVisible()) {
    await targetCell.click()
    await alice.keyboard.type("BADWORD")
    // Click away to commit
    await alice.keyboard.press("Escape")
    await alice.waitForTimeout(500)
  }

  // Wait for an issue pill to appear.
  const issuePill = alice.locator('[aria-label*="issue"]').first()
  await expect(issuePill).toBeVisible({ timeout: 10_000 })

  // Hover the pill — popover should appear with the rule name.
  await issuePill.hover()

  // The popover lists rule name or "issue(s)" heading.
  const popover = alice.locator('[role="tooltip"], [data-state="open"]').filter({ hasText: /issue|bad word/i }).first()
  await expect(popover).toBeVisible({ timeout: 5_000 })
})
