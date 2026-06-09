import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology — delete a concept.
 *
 * ConceptRow has a "Delete concept <source>" button (aria-label). Clicking
 * it calls handleDelete() which calls deleteConcept() without a confirmation
 * dialog — the concept is removed immediately from the list.
 */
test("terminology delete concept removes it from the list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermDel ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Add a concept to delete.
  const termToDelete = `DeleteMe ${Date.now()}`
  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill(termToDelete)
  await dialog.locator('input[placeholder="rendering"]').fill("rendu")
  await dialog.getByRole("button", { name: /Add concept/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Concept row is visible.
  await expect(alice.getByText(termToDelete).first()).toBeVisible({ timeout: 5_000 })

  // Click "Delete concept <term>" button — no dialog, immediate removal.
  const deleteBtn = alice.getByRole("button", { name: new RegExp(`Delete concept ${termToDelete}`, "i") })
  await expect(deleteBtn).toBeVisible({ timeout: 3_000 })
  await deleteBtn.click()

  // Concept disappears from the list.
  await expect(alice.getByText(termToDelete)).not.toBeVisible({ timeout: 5_000 })
})
