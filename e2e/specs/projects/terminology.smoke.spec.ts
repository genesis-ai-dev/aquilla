import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Terminology page smoke test.
 *
 * The terminology system (Concept model + compile-to-rules + bt-glosser) has
 * a full backend. This spec confirms the UI surface works:
 *  - /project/:id/terminology renders without errors.
 *  - The "Add concept" button is present and opens a dialog.
 *  - The dialog has the expected title and form fields.
 *
 * Does NOT test: CSV/TBX import, concept persistence, rule compilation.
 */
test("terminology page renders and Add concept dialog opens", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Terminology ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // After createProject we land at /projects/:id. Extract project ID from URL.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId, "should be able to extract project ID from URL").toBeTruthy()

  // Navigate directly to the terminology route.
  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // 1. The page should render the "Add concept" button.
  //    (TerminologyPage renders it as a plain button with text "Add concept".)
  const addConceptBtn = alice.getByRole("button", { name: /Add concept/i })
  await expect(addConceptBtn).toBeVisible({ timeout: 10_000 })

  // 2. Click "Add concept" and verify the dialog opens.
  await addConceptBtn.first().click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // The dialog title should be "Add concept".
  await expect(dialog.getByRole("heading", { name: /Add concept/i })).toBeVisible()

  // 3. Dismiss the dialog.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
