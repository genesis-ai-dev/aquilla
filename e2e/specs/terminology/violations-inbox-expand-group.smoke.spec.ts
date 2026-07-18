import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Glossary } from "../../helpers/page-objects/Glossary"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TerminologyViolationsInbox — expand concept group row.
 *
 * TerminologyViolationsInbox renders one collapsible row per concept that has
 * violations. The group button has aria-expanded (false by default). Clicking
 * it toggles the infraction list open.
 *
 * Setup to produce a real violation. Two constraints from the shared engine:
 *   - compileConceptsToRules only compiles ACTIVE (approved) concepts, so the
 *     concept's status must be set to "approved" (default is draft/suggested).
 *   - checkRulesForCell short-circuits on empty targets (rule-engine.ts step 2),
 *     so UNTRANSLATED cells produce no missing-approved violations — the
 *     "sample" cell must be given a translation that lacks the approved
 *     rendering.
 *
 *   1. Import sample.md (one cell's original contains "sample").
 *   2. Translate that cell with text that does NOT contain the rendering.
 *   3. Create an APPROVED concept sourceTerm="sample", rendering "échantillon".
 *
 * Then:
 *   4. Navigate to Violations tab.
 *   5. Verify the concept group row appears (aria-expanded=false).
 *   6. Click it → aria-expanded=true, infraction list appears.
 */
test("violations inbox concept group expands to show infraction list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ViolExpand ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.waitForEditor()

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

  // Navigate to Terminology page.
  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()
  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("sample", "échantillon")
  await glossary.openViolations()

  // A concept group row should appear for "sample" (violations > 0).
  // The group button has aria-expanded attribute.
  const groupBtn = alice.locator('button[aria-expanded]').filter({ hasText: /sample/i }).first()
  await expect(groupBtn).toBeVisible({ timeout: 10_000 })

  // Verify initially collapsed.
  await expect(groupBtn).toHaveAttribute("aria-expanded", "false")

  // Click to expand.
  await groupBtn.click()
  await expect(groupBtn).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 })

  // Infraction list should now be visible (ul.mt-2 with li items).
  const infractions = alice.locator("ul.mt-2 li").first()
  await expect(infractions).toBeVisible({ timeout: 3_000 })
})
