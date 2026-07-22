import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * ProjectSettings — "More save options" dropdown with "Close without saving".
 *
 * When changes are made to project settings, a "Save changes" button appears
 * next to a "More save options" dropdown trigger (aria-label="More save options").
 * The dropdown contains "Close without saving" which opens a discard dialog.
 *
 * This spec: navigate to project settings → change the source language (makes
 * settings dirty) → click "More save options" → verify "Close without saving"
 * appears → click it → verify a discard/confirm dialog appears.
 */
test("project settings More save options shows Close without saving", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `MoreSave ${Date.now()}` })

  await alice.goto(`/project/${seeded.projectId}/settings/general`)
  await alice.waitForLoadState("networkidle")

  const sourceLanguage = alice.locator("#sl")
  await expect(sourceLanguage).toBeVisible({ timeout: 10_000 })
  await sourceLanguage.fill("English (US)")

  // "Save changes" button should appear.
  const saveBtn = alice.getByRole("button", { name: /Save changes/i })
  await expect(saveBtn).toBeVisible({ timeout: 5_000 })

  // Click "More save options" dropdown trigger.
  const moreBtn = alice.locator('[aria-label="More save options"]')
  await expect(moreBtn).toBeVisible({ timeout: 3_000 })
  await moreBtn.click()

  // "Close without saving" menu item appears.
  const closeWithoutSaving = alice.getByRole("menuitem", { name: /Close without saving/i })
    .or(alice.getByText(/Close without saving/i).first())
  await expect(closeWithoutSaving).toBeVisible({ timeout: 3_000 })
  await closeWithoutSaving.click()

  // A discard confirmation dialog appears. (Don't union with getByText —
  // the header's "Unsaved changes" span also matches, which makes the
  // union resolve to several elements and trip strict mode.)
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText(/Discard changes\?/i)).toBeVisible()
})
