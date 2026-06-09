import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TerminologyPage — "Notes" field in the concept dialog saves and displays.
 *
 * ConceptDialog (in TerminologyPage.tsx) has a textarea:
 *   id="concept-notes"
 *   placeholder="Contextual notes for translators"
 *
 * Filling it and clicking "Add concept" saves the notes. The concept detail
 * view should then show the notes text.
 *
 * This spec: navigate to terminology → open "Add concept" → fill
 * #concept-source-term and #concept-notes → save → click the concept →
 * verify the notes text appears on the detail page.
 */
test("terminology concept notes field saves and is visible in detail view", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermNotes ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Open the "Add concept" dialog.
  await alice.getByRole("button", { name: /Add concept/i }).first().click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Fill source term.
  const sourceTerm = `grace-${Date.now()}`
  await dialog.locator("#concept-source-term").fill(sourceTerm)

  // Fill notes.
  const notesText = "Used specifically for divine grace, not human kindness."
  const notesField = dialog.locator("#concept-notes")
  await expect(notesField).toBeVisible({ timeout: 3_000 })
  await notesField.fill(notesText)

  // Fill a target rendering.
  await dialog.locator('input[placeholder="rendering"]').first().fill("grâce")

  // Save.
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // The new concept appears in the list. Click it to see detail.
  const conceptLink = alice.getByText(sourceTerm).first()
  await expect(conceptLink).toBeVisible({ timeout: 5_000 })
  await conceptLink.click()

  // The notes text is visible in the detail view.
  await expect(alice.getByText(notesText).first()).toBeVisible({ timeout: 5_000 })
})
