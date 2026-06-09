import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology concept dialog — concept status select.
 *
 * TerminologyPage.tsx ConceptDialog renders a #concept-status <select>:
 *   - "suggested" (draft)
 *   - "approved" (active)
 *   - "old" (deprecated)
 *
 * Default is "suggested". Changing to "approved" then saving produces
 * an "approved" concept. The dialog closes and the concept appears in the list.
 *
 * This spec: open Add concept dialog → verify status defaults to "suggested" →
 * change to "approved" → fill required fields → save → dialog closes.
 */
test("terminology concept dialog status select changes concept status", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermStatus ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Open "Add concept" dialog.
  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Status select defaults to "suggested".
  const statusSelect = dialog.locator("#concept-status")
  await expect(statusSelect).toBeVisible({ timeout: 3_000 })
  await expect(statusSelect).toHaveValue("draft")

  // Change to "approved".
  await statusSelect.selectOption("active")
  await expect(statusSelect).toHaveValue("active")

  // Fill required fields and save.
  const sourceTerm = `StatusConcept ${Date.now()}`
  await dialog.locator("#concept-source-term").fill(sourceTerm)
  await dialog.locator('[aria-label="Rendering 1 text"]').fill("rendu")

  const saveBtn = dialog.getByRole("button", { name: /Add concept/i })
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()

  // Dialog closes and concept appears in the list.
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(sourceTerm).first()).toBeVisible({ timeout: 5_000 })
})
