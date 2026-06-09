import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology — add a concept end-to-end.
 *
 * ConceptDialog has:
 *   - input#concept-source-term for the source term
 *   - Target renderings input (placeholder "rendering")
 *   - "Add concept" save button
 *
 * After saving, the concept appears in the terminology list.
 */
test("add concept saves and appears in terminology list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Terms ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  await alice.getByRole("button", { name: /Add concept/i }).first().click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Fill source term.
  const sourceTerm = `spirit-${Date.now()}`
  await dialog.locator("#concept-source-term").fill(sourceTerm)

  // Fill target rendering.
  const rendering = "esprit"
  await dialog.locator('input[placeholder="rendering"]').first().fill(rendering)

  // Save.
  await dialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 5_000 })

  // The new concept appears in the list.
  await expect(alice.getByText(sourceTerm).first()).toBeVisible({ timeout: 5_000 })
})
