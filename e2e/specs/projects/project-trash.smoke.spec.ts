import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Project soft-delete — "Archive" removes the project from the active list.
 *
 * The old Dashboard ProjectCard "Move to Trash" flow is gone:
 * src/components/Dashboard.tsx is no longer routed. Project soft-delete now
 * lives on the project Overview page (/projects/:id): the header's overflow
 * menu (aria-label="More actions", src/components/org/ProjectOverview.tsx)
 * has an owner-only "Archive" item. Archiving navigates to the org Projects
 * table, where the archived project no longer appears (it moves to
 * /orgs/:id/archived).
 *
 * This spec: creates two projects → archives the second from its Overview →
 * verifies it disappears from the Projects list while the first remains.
 */
test("Archive removes project from active projects list", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const keepName = `Keep ${Date.now()}`
  const archiveName = `Archive ${Date.now()}`

  // Create two projects so the projects list is not empty after archiving one.
  await dash.createProject({ name: keepName })
  await dash.goto()
  await dash.createProject({ name: archiveName })

  // Project creation lands on the project Overview (/projects/:id).
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  await expect(alice.getByRole("heading", { name: archiveName })).toBeVisible({ timeout: 10_000 })

  // Open the header overflow menu and click "Archive", then confirm.
  await alice.getByRole("button", { name: /More actions/i }).click()
  const archiveItem = alice.getByRole("menuitem", { name: /^Archive$/ })
  await expect(archiveItem).toBeVisible({ timeout: 3_000 })
  await archiveItem.click()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("checkbox", { name: /I understand this project will be hidden/i }).check()
  await dialog.getByRole("button", { name: /^Archive$/ }).click()

  // Archiving navigates to the org Projects table (not Overview).
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}/projects/?$`), { timeout: 10_000 })

  // The archived project is gone from the active list; the other remains.
  await expect(alice.getByText(keepName)).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByText(archiveName)).not.toBeVisible({ timeout: 8_000 })
})
