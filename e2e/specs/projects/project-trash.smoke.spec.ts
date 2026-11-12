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

  // Project creation lands on the project Overview (/projects/:id). The exact
  // h1 selector lives on the page object (AQU-1664): a plain name lookup here
  // also matched the "Created <name> in <destination>" toast's <h2>, and
  // Playwright's strict mode failed on the two headings before archiving.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  await expect(dash.projectOverviewHeading(archiveName)).toBeVisible({ timeout: 10_000 })

  // Open the header overflow menu and click "Archive", then confirm.
  await alice.getByRole("button", { name: /More actions/i }).click()
  const archiveItem = alice.getByRole("menuitem", { name: /^Archive$/ })
  await expect(archiveItem).toBeVisible({ timeout: 3_000 })
  await archiveItem.click()
  const dialog = alice.getByRole("dialog", { name: "Archive project", exact: true })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole("checkbox", { name: /I understand this project will be hidden/i }).check()
  await dialog.getByRole("button", { name: /^Archive$/ }).click()

  // Archiving navigates to the org Projects table (not Overview).
  await alice.waitForURL(new RegExp(`/orgs/${alice.orgId}/projects/?$`), { timeout: 10_000 })

  // The archived project is gone from the active list; the other remains.
  // Asserted on the table's own name cell, not on page text (AQU-1664): the
  // create toast carries the project name and outlives the navigation, so a
  // bare getByText check was really racing the toast's auto-dismiss. The
  // kept row lands first, so the table has rendered before the absence of the
  // archived row is read as an empty count rather than an unrendered one.
  await expect(dash.projectRow(keepName)).toBeVisible({ timeout: 10_000 })
  await expect(dash.projectRow(archiveName)).toHaveCount(0, { timeout: 8_000 })
})
