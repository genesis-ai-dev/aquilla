import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ImportDialog — eBible Corpus screen.
 *
 * ImportDialog.tsx has three screens: landing, upload, ebible.
 * The eBible Corpus option on the landing navigates to the "ebible" screen
 * which shows "eBible Corpus" as the dialog title.
 *
 * This spec: opens the import dialog → clicks "eBible Corpus" →
 * verifies the "eBible Corpus" screen heading → clicks Back to return.
 */
test("import dialog eBible Corpus screen renders and Back returns to landing", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EBible ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  await alice.waitForLoadState("networkidle")

  const importBtn = alice.getByRole("button", { name: /^Import$/i }).first()
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await importBtn.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Click "eBible Corpus" on landing.
  await dialog.getByText("eBible Corpus").click()

  // The dialog title / heading updates to "eBible Corpus".
  await expect(dialog.getByRole("heading", { name: /eBible Corpus/i })).toBeVisible({
    timeout: 3_000,
  })

  // Back button returns to landing screen.
  await dialog.getByRole("button", { name: /Back/i }).click()
  await expect(dialog.getByRole("heading", { name: /^Import$/i })).toBeVisible({
    timeout: 3_000,
  })

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
