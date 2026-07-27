import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"


/**
 * ImportDialog — "Back to import types" button.
 *
 * ImportDialog.tsx uses a three-screen state machine:
 *   "landing" | "upload" | "ebible"
 *
 * Landing shows two option cards: "Upload Files" and "eBible Corpus".
 * When "Upload Files" is clicked, screen = "upload" and the DialogTitle
 * changes to show a "← Back to import types" button (aria-label).
 * Clicking Back sets screen back to "landing", restoring the option cards.
 *
 * This spec: opens the import dialog → clicks "Upload Files" → verifies
 * the back button appears → clicks it → verifies the landing cards return.
 */
test("import dialog back button returns to landing screen", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ImportBack ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)
  // Open the import dialog via the empty-workspace primary Import action.
  const importBtn = alice
    .getByRole("button", { name: /^Import(?: a file)?$/i })
    .first()
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await importBtn.click()

  // Landing screen shows "Upload Files" and "eBible Corpus" options.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  const uploadCard = dialog.getByText("Upload Files")
  await expect(uploadCard).toBeVisible({ timeout: 3_000 })
  const ebibleCard = dialog.getByText("eBible Corpus")
  await expect(ebibleCard).toBeVisible({ timeout: 3_000 })

  // Click "Upload Files" to go to the upload screen.
  await uploadCard.click()

  // Back button should appear and landing cards should be hidden.
  const backBtn = dialog.locator('[aria-label="Back to import types"]')
  await expect(backBtn).toBeVisible({ timeout: 3_000 })

  // Title now shows "Upload Files" (not the landing title "Import").
  await expect(dialog.getByText("Upload Files", { exact: false })).toBeVisible()

  // Click back — landing cards should return.
  await backBtn.click()

  // Landing cards re-appear.
  await expect(uploadCard).toBeVisible({ timeout: 3_000 })
  await expect(ebibleCard).toBeVisible({ timeout: 3_000 })
  // Back button should be hidden again.
  await expect(backBtn).not.toBeVisible({ timeout: 3_000 })
})
