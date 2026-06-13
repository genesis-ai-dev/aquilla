import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ConfirmActionDialog — checkbox must be checked before Confirm is enabled.
 *
 * The old vehicle for this behavior (Dashboard "Move to Trash") is gone:
 * src/components/Dashboard.tsx is no longer routed, and project soft-delete
 * is now the unconfirmed "Archive" action on ProjectOverview. RulesPage's
 * delete-rule dialog is also unreachable (RulesPage.tsx isn't routed; the
 * /rules surface deletes inline without confirmation). The live FRO-291
 * vehicle is the terminology concept delete (TerminologyPage.tsx):
 *   <ConfirmActionDialog
 *     title="Delete concept"
 *     confirmLabel="Delete concept"
 *     checkboxLabel="I understand this deletes the concept and all its renderings…"
 *   />
 * ConfirmActionDialog.tsx keeps the confirm button disabled until the
 * checkbox is checked.
 *
 * This spec: creates a project → adds a concept on /project/:id/terminology →
 * clicks "Delete concept <term>" → verifies the dialog opens → confirm is
 * disabled → checks the checkbox → confirm enables → cancels (the concept
 * must survive).
 */
test("confirm action dialog confirm button enabled only after checking checkbox", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const projectName = `ConfirmDialog ${Date.now()}`
  await dash.createProject({ name: projectName })

  // Project creation lands on /projects/:id — grab the id for the terminology page.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/terminology`)
  await alice.waitForLoadState("networkidle")

  // Create a concept so there is something to delete. The dialog requires a
  // source term and at least one rendering before "Add concept" enables.
  await alice.getByRole("button", { name: /^Add concept$/i }).first().click()
  const addDialog = alice.getByRole("dialog")
  await expect(addDialog).toBeVisible({ timeout: 5_000 })
  const term = `confirmterm${Date.now()}`
  await addDialog.locator("#concept-source-term").fill(term)
  await addDialog.getByRole("textbox", { name: "Rendering 1 text" }).fill("bonjour")
  await addDialog.getByRole("button", { name: /^Add concept$/i }).click()
  await expect(addDialog).not.toBeVisible({ timeout: 5_000 })

  // Click "Delete concept <term>" — opens the ConfirmActionDialog (FRO-291).
  await alice.getByRole("button", { name: `Delete concept ${term}` }).click()

  // The ConfirmActionDialog opens.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /^Delete concept$/i })).toBeVisible()

  // The confirm button is disabled before the checkbox is checked.
  const confirmBtn = dialog.getByRole("button", { name: /^Delete concept$/i })
  await expect(confirmBtn).toBeDisabled({ timeout: 3_000 })

  // Check the "I understand" checkbox (Base UI: role=checkbox span; the hidden
  // native input can add a second nameless checkbox node — target by name).
  const checkbox = dialog.getByRole("checkbox", {
    name: /I understand this deletes the concept/i,
  })
  await expect(checkbox).toBeVisible({ timeout: 3_000 })
  await checkbox.check()

  // Confirm button is now enabled.
  await expect(confirmBtn).toBeEnabled({ timeout: 2_000 })

  // Cancel to avoid actually deleting — the concept must still be listed.
  await dialog.getByRole("button", { name: /Cancel/i }).click()
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  await expect(alice.getByText(term).first()).toBeVisible({ timeout: 3_000 })
})
