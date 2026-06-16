import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * TerminologyTermDetail — inline cell editing.
 *
 * FRO-206 added TerminologyTermDetail with a "click-to-edit" OccurrenceRow.
 * When a concept has occurrences in loaded cells and canEdit is true (always
 * for local/no-origin projects), each occurrence row is a <button
 * title="Click to edit">. Clicking it opens a TranslatedEditor inline.
 *
 * The commit path is: emitTargetCellCommit → outbox → D1 projection.
 * For this smoke spec, we verify the inline editor appears and accepts input.
 *
 * Setup:
 *   1. Create a local project (no origin → canEdit = true).
 *   2. Add a concept with sourceTerm="sample".
 *   3. Import sample.md — first cell original contains "sample".
 *   4. Navigate to terminology page — cells load from the file.
 *   5. Click the "sample" concept to open TerminologyTermDetail.
 *   6. An occurrence row should be visible (title="Click to edit").
 *   7. Click it — TranslatedEditor appears (a textarea/div[contenteditable]).
 *   8. Type a value — editor accepts input.
 */
test("terminology term detail occurrence row opens inline editor on click", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermDetailEdit ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Add a concept before importing the file.
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill("sample")
  // At least one rendering is required to save — fill the pre-populated row.
  await dialog.locator('input[aria-label="Rendering 1 text"]').fill("échantillon")
  await dialog.getByRole("button", { name: /Add concept/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Import sample.md from the workspace.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.waitForEditor()

  // Navigate back to terminology.
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Wait for the concept to be visible. Scope to the concept row — the
  // sidebar file row ("sample.md") and the row's Edit/Delete buttons also
  // match /sample/i.
  const conceptBtn = alice
    .locator('[data-testid="concept-row"]')
    .getByRole("button", { name: "sample", exact: true })
    .first()
  await expect(conceptBtn).toBeVisible({ timeout: 10_000 })
  await conceptBtn.click()

  // TerminologyTermDetail opens — "Close detail" button should appear.
  const closeBtn = alice.getByRole("button", { name: /Close detail/i })
  await expect(closeBtn).toBeVisible({ timeout: 5_000 })

  // Wait for occurrences to load (cells come from the loaded file).
  // The "1 occurrence" (or "N occurrences") count should appear.
  const occurrenceCount = alice.getByText(/occurrence/i).first()
  await expect(occurrenceCount).toBeVisible({ timeout: 10_000 })

  // Click the occurrence row's "Click to edit" button.
  const editableRow = alice.getByRole("button", { name: /\(empty\)/ }).first()
  await expect(editableRow).toBeVisible({ timeout: 5_000 })
  await editableRow.click()

  // TranslatedEditor appears — a ProseMirror contenteditable (or textarea
  // fallback).
  const editor = alice.locator('[contenteditable="true"], textarea').first()
  await expect(editor).toBeVisible({ timeout: 5_000 })

  // Type something — editor accepts input. (toHaveValue only works on
  // input/textarea/select, so assert on the rendered text instead — the
  // editor here is a ProseMirror contenteditable.)
  await editor.click()
  await alice.keyboard.type("Traduction test")
  await expect(editor).toContainText("Traduction test")
})
