import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Glossary } from "../../helpers/page-objects/Glossary"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * PreAcceptanceWarningBand — terminology advisory for forbidden renderings.
 *
 * EditorTable.tsx (line ~1586) computes `preAcceptanceWarnings` from
 * `detectPreAcceptanceWarnings(cell.translated, cell.original, project.terminology)`.
 * When the user types a `forbidden` rendering of a concept whose source term
 * appears in that cell's source text, a warning band renders:
 *
 *   <div role="status"> containing "Terminology advisory" and
 *   "Forbidden rendering «<term>» used for <sourceTerm>."
 *
 * Setup:
 *   1. Create a concept: sourceTerm="sample", rendering="verboten" (forbidden),
 *      concept status "approved" (= `active` — detectPreAcceptanceWarnings
 *      skips draft/deprecated concepts, and new concepts default to draft).
 *      "sample" appears in cell 1 of sample.md ("This is a **sample** markdown
 *      file for e2e import testing." — cell 0 is the "# Heading" heading cell).
 *   2. Import sample.md.
 *   3. Edit cell 1 — type "verboten" and blur (the band recomputes from the
 *      committed cell.translated, so the edit must commit).
 *   4. Verify "Terminology advisory" warning band appears.
 *   5. Verify the forbidden rendering message is present.
 */
test("pre-acceptance warning band appears when forbidden rendering is typed", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `PreAccept ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  const glossary = new Glossary(alice)
  await glossary.goto(projectId!)
  await glossary.addTerm("sample", "verboten")
  await glossary.setRenderingStatus("sample", "forbidden")

  // Import sample.md and open the editor.
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Cell 1's source contains "sample" (cell 0 is the "# Heading" cell).
  // Type the forbidden rendering "verboten" and blur so the edit commits —
  // the band recomputes from the committed cell.translated, not live input.
  await ws.editCell(1, "verboten")

  // The warning band should appear.
  const band = alice.locator('[role="status"]').filter({ hasText: /Terminology advisory/i })
  await expect(band.first()).toBeVisible({ timeout: 5_000 })
  await expect(band.first()).toContainText(/Forbidden rendering/i)
  await expect(band.first()).toContainText(/verboten/i)
})
