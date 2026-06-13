import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Project soft-delete — "Archive" removes the project from the active list.
 *
 * The old Dashboard ProjectCard "Move to Trash" flow is gone:
 * src/components/Dashboard.tsx is no longer routed. Project soft-delete now
 * lives on the project Overview page (/projects/:id): the header's overflow
 * menu (aria-label="More actions", src/components/org/ProjectOverview.tsx)
 * has an owner-only "Archive" item. Archiving navigates back to /projects,
 * where the archived project no longer appears (it moves to
 * /projects/archived).
 *
 * This spec: creates two projects → archives the second from its Overview →
 * verifies it disappears from the /projects list while the first remains.
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

  // Open the header overflow menu and click "Archive".
  await alice.getByRole("button", { name: /More actions/i }).click()
  const archiveItem = alice.getByRole("button", { name: /^Archive$/ })
  await expect(archiveItem).toBeVisible({ timeout: 3_000 })
  await archiveItem.click()

  // Archiving navigates back to the projects list.
  await alice.waitForURL(/\/projects$/, { timeout: 10_000 })

  // The archived project is gone from the active list; the other remains.
  await expect(alice.getByText(keepName)).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByText(archiveName)).not.toBeVisible({ timeout: 8_000 })
})
