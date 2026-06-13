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
 *   2. Opens the Add concept dialog (sourceTerm "hello").
 *   3. Fills the pre-populated Rendering 1 row with "bonjour".
 *   4. Adds a second rendering "salut" via "Add rendering".
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

  // Fill source term (Input id="concept-source-term"; the label gives the
  // accessible name "Source term" — there is no aria-label/placeholder
  // containing "source").
  const sourceInput = alice.locator("#concept-source-term")
  await expect(sourceInput).toBeVisible({ timeout: 5_000 })
  await sourceInput.fill("hello")

  // The dialog pre-populates Rendering 1 — fill it with "bonjour".
  const rend1 = alice.locator('input[aria-label="Rendering 1 text"]')
  await expect(rend1).toBeVisible({ timeout: 3_000 })
  await rend1.fill("bonjour")

  // Add a second rendering "salut".
  const addRenderingBtn = alice.getByRole("button", { name: /add rendering/i }).first()
  await expect(addRenderingBtn).toBeVisible({ timeout: 3_000 })
  await addRenderingBtn.click()
  const rend2 = alice.locator('input[aria-label="Rendering 2 text"]')
  await expect(rend2).toBeVisible({ timeout: 3_000 })
  await rend2.fill("salut")

  // Both renderings should be visible.
  await expect(rend1).toHaveValue("bonjour", { timeout: 3_000 })
  await expect(rend2).toHaveValue("salut", { timeout: 3_000 })

  // Click "Remove rendering 1" — removes "bonjour".
  const removeBtn = alice.locator('button[aria-label="Remove rendering 1"]')
  await expect(removeBtn).toBeVisible({ timeout: 3_000 })
  await removeBtn.click()

  // The second row is gone and the remaining row shifted up to "salut".
  await expect(rend2).not.toBeVisible({ timeout: 3_000 })
  await expect(rend1).toHaveValue("salut", { timeout: 3_000 })
})
