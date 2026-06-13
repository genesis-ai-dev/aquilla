import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
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

  // Add a concept with source term "sample" and a forbidden rendering "verboten".
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill("sample")
  // Add a rendering and set it to forbidden.
  await dialog.locator('input[placeholder="rendering"]').fill("verboten")
  // Set status to "forbidden" via the status select (Base UI combobox trigger
  // keeps the aria-label; the option label is "forbidden").
  const statusSelect = dialog.locator('[aria-label="Rendering 1 status"]')
  await expect(statusSelect).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, statusSelect, "forbidden")
  // New concepts default to "suggested" (draft) and detectPreAcceptanceWarnings
  // only considers active concepts — set the concept status to "approved".
  const conceptStatus = dialog.locator("#concept-status")
  await expect(conceptStatus).toBeVisible({ timeout: 3_000 })
  await pickSelectOption(alice, conceptStatus, "approved")
  await dialog.getByRole("button", { name: /Add concept/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Import sample.md and open the editor.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

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
