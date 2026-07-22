import { test, expect } from "../../helpers/multi-user"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * TerminologyViolationsInbox — expand a concept row and see violation cells.
 *
 * sample.md source cells contain the word "sample" (one cell's text starts
 * with "This is a **sample** markdown file…"). When:
 *   - A concept with sourceTerm="sample" and status="active" (approved) exists
 *   - The project has cells (from import) whose source contains "sample"
 *   - That cell is TRANSLATED but its target lacks an approved rendering
 *     (the rule engine short-circuits on empty targets — checkRulesForCell
 *     step 2 — so untranslated cells produce no violations)
 *
 * The violations inbox produces a "missing-approved" group for the concept
 * (source contains the term, target has no approved rendering). The row
 * expand/collapse toggle reveals the individual cell violations.
 *
 * This spec:
 *   1. Creates a project and imports sample.md.
 *   2. Translates the "sample" cell with text that lacks the rendering.
 *   3. Adds a concept: sourceTerm="sample", status=active, rendering="muestra".
 *   4. Navigates to /terminology → "Violations" tab.
 *   5. Verifies the "sample" concept row appears with a violation count.
 *   6. Expands the row → cell violation items become visible.
 */
test("terminology violations inbox expands concept row to show cell violations", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `TermViolExpand ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // The rule engine skips untranslated cells, so give the cell whose source
  // contains "sample" a translation that LACKS the approved rendering.
  const rows = alice.locator("[data-cell-id]")
  const rowCount = await rows.count()
  let sampleIdx = -1
  for (let i = 0; i < rowCount; i++) {
    const text = (await rows.nth(i).textContent()) ?? ""
    if (/sample/i.test(text)) {
      sampleIdx = i
      break
    }
  }
  expect(sampleIdx).toBeGreaterThanOrEqual(0)
  await ws.editCell(sampleIdx, "Ceci est un fichier de test.")

  const projectId = seeded.projectId

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("sample", "muestra")
  await glossary.openViolations()

  // The violations inbox scans cells. The "sample" cell is translated without
  // the approved rendering → at least 1 "missing-approved" violation.
  // The concept group row for "sample" should appear with a count badge.
  // Scope the expand toggle to the row bearing the term — other shell
  // buttons (select triggers, menus) also carry aria-expanded.
  const expandBtn = alice
    .locator("button[aria-expanded]")
    .filter({ hasText: /sample/i })
    .first()
  await expect(expandBtn).toBeVisible({ timeout: 15_000 })
  await expect(expandBtn).toHaveAttribute("aria-expanded", "false")
  await expandBtn.click()
  await expect(expandBtn).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 })

  // After expanding, the cell violation items should appear — each infraction
  // li carries a "missing" badge.
  const infraction = alice.locator("ul.mt-2 li").first()
  await expect(infraction).toBeVisible({ timeout: 5_000 })
  await expect(infraction.getByText("missing").first()).toBeVisible({ timeout: 3_000 })
})
