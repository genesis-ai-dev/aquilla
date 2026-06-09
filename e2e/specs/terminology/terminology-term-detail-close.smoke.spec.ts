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

  const sourceInput = alice.locator('input[aria-label*="source" i], input[placeholder*="source" i]').first()
  await expect(sourceInput).toBeVisible({ timeout: 5_000 })
  await sourceInput.fill("hello")
  await sourceInput.press("Enter")

  // Save the concept (close edit form).
  const saveBtn = alice.getByRole("button", { name: /save|done|confirm/i }).first()
  if (await saveBtn.isVisible({ timeout: 1_500 }).catch(() => false)) await saveBtn.click()
  await alice.waitForTimeout(500)

  // Click the concept row to open the term detail drawer.
  const conceptRow = alice.locator('[data-testid="concept-row"]').first()
  await expect(conceptRow).toBeVisible({ timeout: 8_000 })
  await conceptRow.click()

  // TerminologyTermDetail panel should open.
  const closeBtn = alice.locator('button[aria-label="Close detail"]')
  await expect(closeBtn).toBeVisible({ timeout: 5_000 })

  // Click close.
  await closeBtn.click()

  // The detail panel should be gone.
  await expect(closeBtn).not.toBeVisible({ timeout: 3_000 })
})
