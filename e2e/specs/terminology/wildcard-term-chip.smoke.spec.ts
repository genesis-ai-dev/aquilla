import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
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
 * This spec:
 *   1. Imports sample.md (contains the word "sample" in cell originals).
 *   2. Navigates to the Terminology page.
 *   3. Creates a concept with sourceTerm "samp*" (wildcard matching "sample").
 *   4. Navigates back to the editor.
 *   5. Verifies that the source original for the first cell shows a terminology
 *      chip (span[data-term] or the chip span rendered by terminology-chip-plugin).
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
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Create a new concept with a wildcard source term "samp*".
  const newConceptBtn = alice.getByRole("button", { name: /new concept|add concept|\+ concept/i }).first()
  await expect(newConceptBtn).toBeVisible({ timeout: 8_000 })
  await newConceptBtn.click()

  // Fill the source term field with a wildcard pattern.
  const sourceTermInput = alice.locator('input[placeholder*="source" i], input[aria-label*="source" i]').first()
  await expect(sourceTermInput).toBeVisible({ timeout: 5_000 })
  await sourceTermInput.fill("samp*")
  await sourceTermInput.press("Enter")

  // Allow terminology to compile.
  await alice.waitForTimeout(1_000)

  // Navigate back to the editor / file.
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The source text for the first cell should contain a terminology chip
  // because "sample" matches the wildcard "samp*".
  // terminology-chip-plugin renders chips as <span> with a special class or data-term.
  const firstRow = ws.cellRow(0)
  await expect(firstRow).toBeVisible({ timeout: 5_000 })

  // Look for a terminology chip inside the first row.
  // terminology-chip-plugin renders: span.term-chip with data-source-term and
  // aria-label="Managed term: samp*"
  const chip = firstRow.locator("span.term-chip, span[data-source-term]").first()
  await expect(chip).toBeVisible({ timeout: 5_000 })
})
