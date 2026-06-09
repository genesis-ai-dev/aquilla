import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology — drill into a concept to see TerminologyTermDetail.
 *
 * ConceptRow renders the sourceTerm inside a <button> (type="button").
 * Clicking that button calls onDrillDown(concept), which sets
 * `drillDownConcept` and renders TerminologyTermDetail instead of the list.
 *
 * TerminologyTermDetail has:
 *   - A "Close detail" button (aria-label)
 *   - The concept source term in a heading/text
 *
 * This spec: add a concept → click its name → detail view opens →
 * "Close detail" returns to the list.
 */
test("terminology drill-down opens term detail and Close returns to list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermDetail ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Add a concept.
  const sourceTerm = `Drill ${Date.now()}`
  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill(sourceTerm)
  await dialog.locator('input[placeholder="rendering"]').fill("forage")
  await dialog.getByRole("button", { name: /Add concept/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Click the source term button to drill into detail.
  const termBtn = alice.getByRole("button", { name: sourceTerm })
  await expect(termBtn).toBeVisible({ timeout: 5_000 })
  await termBtn.click()

  // TerminologyTermDetail is shown — the list is replaced.
  // The "Close detail" button (aria-label) is visible.
  const closeDetailBtn = alice.getByRole("button", { name: /Close detail/i })
  await expect(closeDetailBtn).toBeVisible({ timeout: 5_000 })

  // The source term text is visible in the detail view.
  await expect(alice.getByText(sourceTerm).first()).toBeVisible({ timeout: 3_000 })

  // Close returns to the concept list.
  await closeDetailBtn.click()
  await expect(closeDetailBtn).not.toBeVisible({ timeout: 3_000 })
  await expect(addBtn).toBeVisible({ timeout: 3_000 })
})
