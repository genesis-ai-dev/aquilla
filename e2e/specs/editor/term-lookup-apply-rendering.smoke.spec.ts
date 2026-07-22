import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

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
  // Project create + terminology round-trip + a full AQU-310 import flow can
  // exceed the 30s harness budget under load.
  test.slow()
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TermApply ${Date.now()}` })

  const glossary = new Glossary(alice)
  await glossary.goto(seeded.projectId)
  await glossary.addTerm("content", "échantillon")

  // Open the seeded file's editor.
  await openSeededProject(alice, seeded)

  // Click on the "content" chip in the source column (dotted underline span).
  const chip = alice.locator("span.underline").filter({ hasText: /^content$/i }).first()
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
    .filter({ has: alice.locator("span.underline").filter({ hasText: /^content$/i }) })
    .first()
  const targetCell = chipRow.locator('[data-cell-type="target"]').first()
  await expect(targetCell).toContainText(/échantillon/, { timeout: 5_000 })
})
