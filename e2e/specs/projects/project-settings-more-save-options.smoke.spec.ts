import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — "More save options" dropdown with "Close without saving".
 *
 * When changes are made to project settings, a "Save changes" button appears
 * next to a "More save options" dropdown trigger (aria-label="More save options").
 * The dropdown contains "Close without saving" which opens a discard dialog.
 *
 * This spec: navigate to project settings → change the project name (makes
 * settings dirty) → click "More save options" → verify "Close without saving"
 * appears → click it → verify a discard/confirm dialog appears.
 */
test("project settings More save options shows Close without saving", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MoreSave ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // Make the form dirty by changing the project name.
  const nameInput = alice.locator("#pname")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await nameInput.fill("Modified Name")

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

  // A discard confirmation dialog appears.
  const dialog = alice.getByRole("dialog")
    .or(alice.getByText(/discard\b/i).first())
    .or(alice.getByText(/unsaved changes/i).first())
  await expect(dialog).toBeVisible({ timeout: 5_000 })
})
