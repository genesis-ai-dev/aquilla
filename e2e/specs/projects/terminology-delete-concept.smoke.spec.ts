import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology — delete a managed concept.
 *
 * ConceptRow.tsx renders a "Delete concept <source>" button
 * (aria-label=`Delete concept ${concept.sourceTerm}`) next to the edit pencil.
 * Clicking it calls handleDelete(conceptId) immediately — no confirmation dialog.
 *
 * This spec:
 *   1. Creates a project → goes to /terminology.
 *   2. Adds a concept "ToDelete" with rendering "target".
 *   3. Verifies the concept row is visible.
 *   4. Clicks the "Delete concept ToDelete" button.
 *   5. Verifies the concept row disappears.
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

  // Add a concept first.
  const sourceTerm = `ToDelete ${Date.now()}`
  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill(sourceTerm)
  await dialog.locator('input[placeholder="rendering"]').fill("target")
  await dialog.getByRole("button", { name: /Add concept/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Concept row is now visible.
  const conceptText = alice.getByText(sourceTerm).first()
  await expect(conceptText).toBeVisible({ timeout: 5_000 })

  // Click the "Delete concept <sourceTerm>" button.
  const deleteBtn = alice.getByRole("button", { name: new RegExp(`Delete concept ${sourceTerm}`, "i") })
  await expect(deleteBtn).toBeVisible({ timeout: 3_000 })
  await deleteBtn.click()

  // Concept row disappears.
  await expect(conceptText).not.toBeVisible({ timeout: 5_000 })
})
