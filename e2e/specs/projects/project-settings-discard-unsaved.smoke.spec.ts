import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — "Discard changes?" dialog.
 *
 * ProjectSettings.tsx:
 *   const isDirty = useMemo(() => name !== baseline.name || ...)
 *
 *   When isDirty=true the header shows a split "Save / ▾" button.
 *   The dropdown contains "Close without saving" which opens a Dialog:
 *     - DialogTitle: "Discard changes?"
 *     - Button variant="ghost": "Keep editing" → closes dialog, stays on settings
 *     - Button variant="destructive": "Discard" → navigates away
 *
 * This spec covers two paths:
 *   A) "Keep editing" → dialog closes, user stays on /settings
 *   B) "Discard" → dialog closes and user is navigated back to editor
 *
 * Flow:
 *   1. Create project → navigate to /project/:id/settings
 *   2. Edit the project name field (makes isDirty=true)
 *   3. Click the "▾" split-button dropdown → click "Close without saving"
 *   4. Dialog opens with title "Discard changes?"
 *   5a. Click "Keep editing" → dialog closes, URL still ends in /settings
 *   5b. Reopen dialog → Click "Discard" → navigated away from /settings
 */
test("project settings discard dialog: Keep editing stays on settings page", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `DiscardSettings ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Navigate to project settings.
  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // Edit the project name to make isDirty=true.
  // Project name field is #pname in the Project Info card.
  const nameInput = alice.locator("#pname")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await nameInput.fill(name + " edited")

  // The "Unsaved changes" text should appear.
  await expect(alice.getByText(/Unsaved changes/i)).toBeVisible({ timeout: 5_000 })

  // Click the "More save options" dropdown (ChevronDown next to Save button).
  const moreBtn = alice.locator('[aria-label="More save options"]')
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  // Click "Close without saving".
  const closeItem = alice.getByRole("menuitem", { name: /Close without saving/i })
    .or(alice.getByText(/Close without saving/i))
  await expect(closeItem).toBeVisible({ timeout: 3_000 })
  await closeItem.click()

  // Dialog with "Discard changes?" title should open.
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByText(/Discard changes\?/i)).toBeVisible()

  // Click "Keep editing" — dialog closes, URL remains on /settings.
  const keepEditingBtn = dialog.getByRole("button", { name: /Keep editing/i })
  await expect(keepEditingBtn).toBeVisible({ timeout: 3_000 })
  await keepEditingBtn.click()

  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  await expect(alice).toHaveURL(/\/settings$/, { timeout: 3_000 })
})

test("project settings discard dialog: Discard navigates away from settings", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `DiscardNav ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // Edit name → make dirty.
  // Project name field is #pname in the Project Info card.
  const nameInput = alice.locator("#pname")
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await nameInput.fill(name + " edited again")
  await expect(alice.getByText(/Unsaved changes/i)).toBeVisible({ timeout: 5_000 })

  // Open dropdown → click "Close without saving".
  const moreBtn = alice.locator('[aria-label="More save options"]')
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()
  const closeItem = alice.getByRole("menuitem", { name: /Close without saving/i })
    .or(alice.getByText(/Close without saving/i))
  await expect(closeItem).toBeVisible({ timeout: 3_000 })
  await closeItem.click()

  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Click "Discard" — navigated away (URL should no longer end in /settings).
  const discardBtn = dialog.getByRole("button", { name: /^Discard$/i })
  await expect(discardBtn).toBeVisible({ timeout: 3_000 })
  await discardBtn.click()

  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  await expect(alice).not.toHaveURL(/\/settings$/, { timeout: 5_000 })
})
