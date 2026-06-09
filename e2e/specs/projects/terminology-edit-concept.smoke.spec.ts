import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology — edit an existing concept.
 *
 * ConceptRow shows an "Edit concept <source>" button (aria-label) that opens
 * the same ConceptDialog with initial values pre-filled. The DialogTitle says
 * "Edit concept" (vs "Add concept"). After saving, the updated source term
 * appears in the concept list.
 */
test("terminology edit concept dialog updates the source term", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermEdit ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Add a concept first.
  const originalTerm = `EditMe ${Date.now()}`
  const addBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addBtn).toBeVisible({ timeout: 10_000 })
  await addBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.locator("#concept-source-term").fill(originalTerm)
  await dialog.locator('input[placeholder="rendering"]').fill("rendu")
  await dialog.getByRole("button", { name: /Add concept/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // Concept row is visible.
  await expect(alice.getByText(originalTerm).first()).toBeVisible({ timeout: 5_000 })

  // Click "Edit concept <originalTerm>" button.
  const editBtn = alice.getByRole("button", { name: new RegExp(`Edit concept ${originalTerm}`, "i") })
  await expect(editBtn).toBeVisible({ timeout: 3_000 })
  await editBtn.click()

  // Edit dialog opens with "Edit concept" title.
  const editDialog = alice.getByRole("dialog")
  await expect(editDialog).toBeVisible({ timeout: 5_000 })
  await expect(editDialog.getByRole("heading", { name: /Edit concept/i })).toBeVisible()

  // Source term input is pre-filled.
  const sourceInput = editDialog.locator("#concept-source-term")
  await expect(sourceInput).toHaveValue(originalTerm, { timeout: 3_000 })

  // Change the term.
  const newTerm = `${originalTerm} — edited`
  await sourceInput.fill(newTerm)

  // Save — button text is "Save changes" in edit mode.
  const saveBtn = editDialog.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()
  await expect(editDialog).not.toBeVisible({ timeout: 5_000 })

  // Updated term appears in list.
  await expect(alice.getByText(newTerm).first()).toBeVisible({ timeout: 5_000 })
})
