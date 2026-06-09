import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectsList page — /projects shows org projects grid.
 *
 * ProjectsList.tsx renders an AppShell with:
 *   - OrgBreadcrumb showing "Projects"
 *   - A "ProjectCreateDialog" button
 *   - A grid of project cards (or "No projects in this org yet." when empty)
 *
 * This spec: create a project via the Dashboard → navigate to /projects →
 * verify the project name appears in the grid.
 */
test("projects list page shows created project in grid", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `ListProj ${Date.now()}`
  await dash.createProject({ name: projName, source: "en", target: "fr" })

  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // Breadcrumb shows "Projects".
  await expect(alice.getByText("Projects").first()).toBeVisible({ timeout: 10_000 })

  // Project grid shows the created project.
  const card = alice.getByText(projName)
  await expect(card).toBeVisible({ timeout: 8_000 })

  // Clicking the project card navigates to /projects/:id.
  await card.click()
  await alice.waitForURL(/\/projects\/[^/]+/, { timeout: 5_000 })
})
