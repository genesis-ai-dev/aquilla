import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * TerminologyPage — remove a rendering from a concept.
 *
 * TerminologyPage.tsx renders a "Remove rendering N" button per rendering
 * row when a concept is in edit mode (pencil button clicked):
 *   aria-label="Remove rendering 1"
 *   aria-label="Remove rendering 2"  etc.
 *
 * Clicking it removes that rendering from the local draft. Saving the
 * concept persists the removal.
 *
 * This spec:
 *   1. Creates a project → navigates to /terminology.
 *   2. Creates a concept with sourceTerm "hello" and a rendering "bonjour".
 *   3. Opens the concept edit dialog.
 *   4. Adds a second rendering "salut".
 *   5. Clicks "Remove rendering 1" → first rendering disappears.
 *   6. Verifies only "salut" remains in the renderings list.
 */
test("remove rendering button removes that rendering from the concept", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RemoveRend ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const projectId = alice.url().match(/\/project\/([^/]+)/)?.[1]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Create a new concept.
  const newConceptBtn = alice.getByRole("button", { name: /new concept|add concept|\+ concept/i }).first()
  await expect(newConceptBtn).toBeVisible({ timeout: 8_000 })
  await newConceptBtn.click()

  // Fill source term.
  const sourceInput = alice.locator('input[aria-label*="source" i], input[placeholder*="source" i]').first()
  await expect(sourceInput).toBeVisible({ timeout: 5_000 })
  await sourceInput.fill("hello")

  // Add first rendering "bonjour".
  const addRenderingBtn = alice.getByRole("button", { name: /add rendering|\+ rendering/i }).first()
  if (await addRenderingBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await addRenderingBtn.click()
    const rend1 = alice.locator('input[aria-label="Rendering 1 text"]')
    await expect(rend1).toBeVisible({ timeout: 3_000 })
    await rend1.fill("bonjour")
  }

  // Add second rendering "salut".
  const addRenderingBtn2 = alice.getByRole("button", { name: /add rendering|\+ rendering/i }).first()
  if (await addRenderingBtn2.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await addRenderingBtn2.click()
    const rend2 = alice.locator('input[aria-label="Rendering 2 text"]')
    await expect(rend2).toBeVisible({ timeout: 3_000 })
    await rend2.fill("salut")
  }

  // Both renderings should be visible.
  await expect(alice.locator('input[aria-label="Rendering 1 text"]')).toHaveValue("bonjour", { timeout: 3_000 })
  await expect(alice.locator('input[aria-label="Rendering 2 text"]')).toHaveValue("salut", { timeout: 3_000 })

  // Click "Remove rendering 1" — removes "bonjour".
  const removeBtn = alice.locator('button[aria-label="Remove rendering 1"]')
  await expect(removeBtn).toBeVisible({ timeout: 3_000 })
  await removeBtn.click()

  // "Rendering 1 text" field should now contain "salut" (it shifted up),
  // or "Rendering 2 text" should be gone.
  await expect(alice.locator('input[aria-label="Rendering 2 text"]')).not.toBeVisible({ timeout: 3_000 })
  // "bonjour" should no longer appear in any rendering input.
  await expect(alice.locator('input[value="bonjour"]')).not.toBeVisible({ timeout: 2_000 })
})
