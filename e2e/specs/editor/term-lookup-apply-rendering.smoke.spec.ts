import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TermLookupPopover — "Apply rendering" button inserts the rendering into
 * the target cell.
 *
 * When a source-cell word matches a terminology concept, clicking the chip
 * opens the popover. Each rendering row (non-forbidden) has an
 *   aria-label="Apply rendering: <rendering>"
 * button. Clicking it appends/sets the rendering in the target cell.
 *
 * This spec:
 *   1. Creates a project + adds a concept "sample" → rendering "échantillon".
 *   2. Imports sample.md and opens the editor.
 *   3. Clicks the "sample" chip in the source column to open the popover.
 *   4. Clicks "Apply rendering: échantillon".
 *   5. Verifies "échantillon" appears in the target cell textarea.
 */
test("term lookup Apply rendering inserts the rendering into target cell", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermApply ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Add terminology concept: "sample" → "échantillon"
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  await alice.getByRole("button", { name: /Add concept/i }).first().click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill("sample")
  await dialog.locator('input[placeholder="rendering"]').first().fill("échantillon")
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Open workspace and import file.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click on the "sample" chip in the source column (dotted underline span).
  const chip = alice.locator('span.cursor-pointer.underline').filter({ hasText: /^sample$/i }).first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  // Popover opens with the concept name.
  const popover = alice.locator('[aria-label*="Terminology lookup"]')
  await expect(popover).toBeVisible({ timeout: 5_000 })

  // "Apply rendering: échantillon" button is visible.
  const applyBtn = alice.locator('[aria-label="Apply rendering: échantillon"]')
  await expect(applyBtn).toBeVisible({ timeout: 3_000 })
  await applyBtn.click()

  // After applying, the rendering text appears in the target cell.
  // The target textarea (or its content) should contain "échantillon".
  const targetCell = ws.cellRow(0).locator('textarea, [contenteditable="true"]').first()
  await expect(targetCell).toHaveValue(/échantillon/, { timeout: 5_000 })
})
