import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Glossary } from "../../helpers/page-objects/Glossary"
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
 *   1. Creates a project + adds a concept "content" → rendering "échantillon".
 *   2. Imports sample.md and opens the editor.
 *   3. Clicks the "content" chip in the source column to open the popover.
 *   4. Clicks "Apply rendering: échantillon".
 *   5. Verifies "échantillon" appears in the target cell textarea.
 *
 * NOTE: the concept word must come from an UNFORMATTED cell. Cells with
 * inline formatting carry `originalHtml` and render via sanitized HTML
 * (EditorTable.tsx), which bypasses SourceWithTermLookup entirely — so the
 * bolded "sample" cell never gets the underline affordance.
 */
test("term lookup Apply rendering inserts the rendering into target cell", async ({ alice }) => {
  // Project create + terminology round-trip + a full FRO-310 import flow can
  // exceed the 30s harness budget under load.
  test.slow()
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermApply ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("content", "échantillon")

  // Open workspace and import file.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Click on the "content" chip in the source column (dotted underline span).
  const chip = alice.locator('span.cursor-pointer.underline').filter({ hasText: /^content$/i }).first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()

  // Popover opens with the concept name.
  const popover = alice.locator('[aria-label*="Terminology lookup"]')
  await expect(popover).toBeVisible({ timeout: 5_000 })

  // "Apply rendering: échantillon" button is visible.
  const applyBtn = alice.locator('[aria-label="Apply rendering: échantillon"]')
  await expect(applyBtn).toBeVisible({ timeout: 3_000 })
  await applyBtn.click()

  // After applying, the rendering text appears in the target cell of the
  // ROW THAT OWNS THE CHIP (the row whose source cell contains the bare
  // word "content").
  const chipRow = alice
    .locator("[data-cell-id]")
    .filter({ has: alice.locator("span.cursor-pointer.underline").filter({ hasText: /^content$/i }) })
    .first()
  const targetCell = chipRow.locator('[data-cell-type="target"]').first()
  await expect(targetCell).toContainText(/échantillon/, { timeout: 5_000 })
})
