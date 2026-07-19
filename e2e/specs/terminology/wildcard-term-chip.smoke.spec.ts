import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Glossary } from "../../helpers/page-objects/Glossary"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Inflectional wildcard matching — editor chip appears for wildcard concept.
 *
 * Wildcard semantics (src/lib/terminology/match.ts):
 *   A literal `*` in a source term matches zero-or-more Unicode letters.
 *   e.g. source term "samp*" matches "sample", "samples", "sampler", etc.
 *
 * The same matcher drives enforcement chips, occurrence matching in
 * TerminologyTermDetail, and the pre-acceptance warning.
 *
 * Where chips render (ground truth): terminology-chip-plugin is wired into
 * the TARGET editor only (TranslatedEditor via the terminologyConcepts prop,
 * EditorTable.tsx) and scans the target doc for ACTIVE concept sourceTerm
 * matches. The source column's term affordance (SourceWithTermLookup) is
 * exact-word only — wildcards never decorate the source side.
 *
 * This spec:
 *   1. Imports sample.md.
 *   2. Creates an APPROVED concept with sourceTerm "samp*" (wildcard
 *      matching "sample") — only active concepts produce chips.
 *   3. Back in the editor, types target text containing "sample" into the
 *      first cell.
 *   4. Verifies the wildcard match renders a terminology chip in that row
 *      (span.term-chip / span[data-source-term]).
 */
test("wildcard source term creates chip matches in the editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Wildcard ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to Terminology page.
  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()
  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("samp*", "échantillon")

  // Navigate back to the editor / file.
  await alice.goto(`/project/${projectId}/editor`)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Type target text containing "sample" — the chip plugin scans the TARGET
  // editor doc and "sample" matches the wildcard "samp*".
  await ws.editCell(0, "Voici le sample")

  const firstRow = ws.cellRow(0)
  await expect(firstRow).toBeVisible({ timeout: 5_000 })

  // Look for a terminology chip inside the first row.
  // terminology-chip-plugin renders: span.term-chip with data-source-term and
  // aria-label="Managed term: samp*" (plus a term-chip-host wrapper span that
  // also carries data-source-term).
  const chip = firstRow.locator("span.term-chip, span[data-source-term]").first()
  await expect(chip).toBeVisible({ timeout: 5_000 })
})
