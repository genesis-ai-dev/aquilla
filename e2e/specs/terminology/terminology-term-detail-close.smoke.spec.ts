import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TerminologyTermDetail — "Close detail" button closes the detail panel.
 *
 * TerminologyTermDetail.tsx renders a close button:
 *   aria-label="Close detail"
 * which calls onClose() to dismiss the detail drawer.
 *
 * This spec:
 *   1. Creates a project, navigates to /terminology.
 *   2. Creates a concept "hello".
 *   3. Opens the term detail by clicking on the concept row.
 *   4. Verifies the detail panel is open.
 *   5. Clicks "Close detail" → panel is no longer visible.
 */
test("TerminologyTermDetail Close button dismisses the detail panel", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermClose ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Create a concept.
  const newConceptBtn = alice.getByRole("button", { name: /new concept|add concept|\+ concept/i }).first()
  await expect(newConceptBtn).toBeVisible({ timeout: 8_000 })
  await newConceptBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Source term input is #concept-source-term (label-named "Source term" —
  // it has no aria-label/placeholder containing "source").
  const sourceInput = dialog.locator("#concept-source-term")
  await expect(sourceInput).toBeVisible({ timeout: 5_000 })
  await sourceInput.fill("hello")

  // At least one rendering is required to save — fill the pre-populated row.
  await dialog.locator('input[aria-label="Rendering 1 text"]').fill("bonjour")

  // Save — the footer button is labelled "Add concept" for new concepts.
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Drill into the detail view by clicking the source-term button in the row
  // (the <li> itself is not clickable — only the term button drills down).
  const conceptRow = alice.locator('[data-testid="concept-row"]').first()
  await expect(conceptRow).toBeVisible({ timeout: 8_000 })
  await conceptRow.getByRole("button", { name: "hello", exact: true }).click()

  // TerminologyTermDetail panel should open.
  const closeBtn = alice.locator('button[aria-label="Close detail"]')
  await expect(closeBtn).toBeVisible({ timeout: 5_000 })

  // Click close.
  await closeBtn.click()

  // The detail panel should be gone.
  await expect(closeBtn).not.toBeVisible({ timeout: 3_000 })
})
