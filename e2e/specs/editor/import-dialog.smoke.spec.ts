import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ImportDialog landing screen.
 *
 * The no-files empty state shows an "Import a file" CTA (AQU-661: the header
 * primary-action button was removed; Import also lives in the ⋯ overflow menu).
 * Either opens ImportDialog. The landing screen shows two options:
 *   - "Upload Files"
 *   - "eBible Corpus"
 *
 * Clicking "Upload Files" navigates to the upload screen with title "Upload Files".
 * Back button returns to landing.
 *
 * This spec exercises the dialog navigation without actually uploading a file
 * (covered by import-and-edit.smoke.spec.ts).
 *
 * AQU-823: also covers the Google Drive entry point. The picker/OAuth flow
 * itself is manual-QA only (external Google dependency); the e2e stack has no
 * VITE_GOOGLE_CLIENT_ID, so the panel deterministically shows the
 * not-configured notice.
 */
test("import dialog shows Upload Files and eBible Corpus options", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Import ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  // Wait for workspace to load. With no files, the cell-area empty state shows
  // an "Import a file" CTA that opens ImportDialog (AQU-661).
  const importBtn = alice.getByRole("button", { name: /Import a file/i }).first()
  await expect(importBtn).toBeVisible({ timeout: 10_000 })
  await importBtn.click()

  // Dialog opens with title "Import".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: /^Import$/i })).toBeVisible()

  // Both import options are on the landing screen.
  await expect(dialog.getByText("Upload Files")).toBeVisible({ timeout: 3_000 })
  await expect(dialog.getByText("eBible Corpus")).toBeVisible({ timeout: 3_000 })

  // Click "Upload Files" → dialog title changes to "Upload Files".
  await dialog.getByText("Upload Files").click()
  await expect(dialog.getByRole("heading", { name: /Upload Files/i })).toBeVisible({
    timeout: 3_000,
  })

  // Back button returns to landing with "Import" title.
  await dialog.getByRole("button", { name: /Back to import types/i }).click()
  await expect(dialog.getByRole("heading", { name: /^Import$/i })).toBeVisible({
    timeout: 3_000,
  })

  // AQU-823: Google Drive option routes to its panel. Without
  // VITE_GOOGLE_CLIENT_ID in the e2e stack the panel shows the deterministic
  // not-configured notice instead of the connect button.
  await expect(dialog.getByText("Google Drive").first()).toBeVisible({ timeout: 3_000 })
  await dialog.getByText("Google Drive").first().click()
  await expect(dialog.getByRole("heading", { name: /Google Drive/i })).toBeVisible({
    timeout: 3_000,
  })
  await expect(dialog.getByText(/isn't configured for this deployment/i)).toBeVisible({
    timeout: 3_000,
  })
  await dialog.getByRole("button", { name: /Back to import types/i }).click()
  await expect(dialog.getByRole("heading", { name: /^Import$/i })).toBeVisible({
    timeout: 3_000,
  })

  // Dismiss.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
