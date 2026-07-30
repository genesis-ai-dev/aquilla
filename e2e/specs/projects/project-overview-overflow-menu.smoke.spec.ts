import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectOverview — ⋯ "More actions" dropdown opens Archive / Download actions.
 *
 * ProjectOverview.tsx renders a DropdownMenu (button aria-label="More actions")
 * when the caller is canManage or isOwner and the project is not archived.
 * The menu contains:
 *   - "Download deliverable" (disabled when no files)
 *   - "Archive" (available to isOwner)
 *
 * This spec: navigate to project overview → click "⋯" → verify dropdown
 * opens with both items visible → click outside → dropdown closes.
 */
test("project overview overflow menu opens with Archive and Download items", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `OvflwMenu ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate to the project overview page (org view).
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/projects/${projectId}`)
  // The "⋯" More actions button is visible.
  const moreBtn = alice.getByRole("button", { name: /More actions/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  // Dropdown is open — "Archive" is visible.
  const archiveItem = alice.getByRole("menuitem", { name: /^Archive$/i })
  await expect(archiveItem).toBeVisible({ timeout: 3_000 })

  // "Download deliverable" is also present (may be disabled since no files).
  const downloadItem = alice.getByRole("menuitem", { name: /Download deliverable/i })
  await expect(downloadItem).toBeVisible({ timeout: 2_000 })

  // Click outside to close the dropdown.
  await alice.locator("body").click({ position: { x: 10, y: 10 } })
  await expect(archiveItem).not.toBeVisible({ timeout: 3_000 })
})
