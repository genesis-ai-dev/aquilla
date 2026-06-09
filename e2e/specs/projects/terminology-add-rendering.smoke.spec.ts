import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology concept dialog — "Add rendering" adds a new rendering row.
 *
 * The concept dialog (TerminologyPage.tsx) has an "Add rendering" button that
 * appends a new empty RenderingRow. Each row uses:
 *   - aria-label="Rendering N text" for the text input
 *   - aria-label="Rendering N status" for the status select
 *   - aria-label="Remove rendering N" for the remove button
 *
 * This spec: open Add concept dialog → verify 1 rendering row →
 * click "Add rendering" → 2 rendering rows visible → fill the second →
 * click "Remove rendering 2" → back to 1 row.
 */
test("terminology concept dialog Add rendering button adds and removes a rendering row", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `TermRendering ${Date.now()}`
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

  // Initially 1 rendering row.
  await expect(dialog.locator('[aria-label="Rendering 1 text"]')).toBeVisible({ timeout: 3_000 })
  await expect(dialog.locator('[aria-label="Rendering 2 text"]')).not.toBeVisible()

  // Click "Add rendering" — second row appears.
  const addRenderingBtn = dialog.getByRole("button", { name: /Add rendering/i })
  await expect(addRenderingBtn).toBeVisible({ timeout: 3_000 })
  await addRenderingBtn.click()
  await expect(dialog.locator('[aria-label="Rendering 2 text"]')).toBeVisible({ timeout: 2_000 })

  // Fill the second rendering text.
  await dialog.locator('[aria-label="Rendering 2 text"]').fill("deuxième")

  // Remove the second rendering — back to 1 row.
  const removeBtn2 = dialog.locator('[aria-label="Remove rendering 2"]')
  await expect(removeBtn2).toBeVisible({ timeout: 2_000 })
  await removeBtn2.click()
  await expect(dialog.locator('[aria-label="Rendering 2 text"]')).not.toBeVisible({ timeout: 2_000 })

  // First row still present.
  await expect(dialog.locator('[aria-label="Rendering 1 text"]')).toBeVisible()

  // Close dialog.
  await alice.keyboard.press("Escape")
})
