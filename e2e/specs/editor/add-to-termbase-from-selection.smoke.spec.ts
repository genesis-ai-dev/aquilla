import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Add-to-termbase from source selection (Slice 5).
 *
 * EditorTable.tsx has an `handleSourceMouseUp` listener on the source cell.
 * When text is selected (mouseup with non-collapsed selection), `sourceSelection`
 * is set and an "Add to termbase" button appears (absolute positioned, primary color).
 *
 * Clicking it calls `handleAddConceptFromSelection(sourceSelection)` which:
 *   1. Creates a DRAFT concept with sourceTerm = selected text.
 *   2. Calls `patchSettings({ terminology: [...] })` to persist it.
 *
 * This spec:
 *   1. Imports sample.md and opens the editor.
 *   2. Selects text in the source cell (Ctrl+A in the source editor or mouse drag).
 *   3. "Add to termbase" button appears.
 *   4. Clicks it.
 *   5. Navigates to the terminology page.
 *   6. Verifies the new concept appears as a DRAFT.
 *
 * Selecting text: TipTap source editor is read-only (source cells aren't editable
 * in the target lens), so we use the browser's Selection API via keyboard:
 * click source cell, triple-click to select all text, then check for the button.
 */
test("selecting source text reveals Add to termbase button and creates draft concept", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AddToTermbase ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Select text in the first source cell by triple-clicking it.
  // The source cell displays the original text from sample.md.

  // Find the source text area — look for the original text area in the first cell.
  // EditorTable renders source text in a div with the original content.
  const sourceArea = alice.locator('[aria-label="Source text"], .source-text, [data-cell-type="source"]').first()

  let addBtn = alice.getByRole("button", { name: /Add to termbase/i })

  if (await sourceArea.isVisible({ timeout: 3_000 })) {
    // Triple-click selects all text in the element.
    await sourceArea.click({ clickCount: 3 })
    await alice.waitForTimeout(300)
  } else {
    // Fallback: find any cell content in the first row and triple-click it.
    const cell = alice.locator('td, [role="gridcell"]').first()
    if (await cell.isVisible({ timeout: 2_000 })) {
      await cell.click({ clickCount: 3 })
      await alice.waitForTimeout(300)
    }
  }

  // Check if the Add to termbase button appeared.
  const btnVisible = await addBtn.isVisible({ timeout: 3_000 })

  if (!btnVisible) {
    // Try directly on the source label text (the cell.original text in TipTap).
    // sample.md first cell original text starts with "This is a"
    const srcText = alice.getByText(/This is a/i).first()
    if (await srcText.isVisible({ timeout: 2_000 })) {
      await srcText.click({ clickCount: 3 })
      await alice.waitForTimeout(300)
    }
  }

  // The Add to termbase button should now be visible.
  await expect(addBtn).toBeVisible({ timeout: 5_000 })

  // Click it — creates a DRAFT concept.
  await addBtn.click()

  // Button should disappear (selection cleared).
  await expect(addBtn).not.toBeVisible({ timeout: 3_000 })

  // Navigate to terminology page and verify the draft concept was created.
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // A concept row should exist with status "draft" (shown as "Draft" badge).
  // The concept's sourceTerm is the text that was selected.
  const conceptRow = alice.locator('[data-testid="concept-row"], tr').filter({ hasText: /draft/i }).first()
  await expect(conceptRow).toBeVisible({ timeout: 10_000 })
})
