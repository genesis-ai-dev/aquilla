import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectsList — per-project role label for the signed-in user.
 *
 * The old Dashboard/ProjectCard surface (title="Your role on this project")
 * is no longer routed; /projects now renders ProjectsList.tsx, where each
 * project row shows the user's role name ({p.role.name}) next to the
 * project name (sortable via the "Role" column header).
 *
 * For alice (who creates the project), the role is "owner"
 * (auth-worker ROLE_NAMES[700]).
 *
 * This spec: creates a project → verifies its row in the projects list
 * shows the "owner" role label.
 */
test("project card shows Your role on this project badge for project owner", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RoleBadge ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // After project creation, navigate back to the projects list.
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // The project's row shows the role label for the signed-in user.
  const row = alice.getByRole("listitem").filter({ hasText: name }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  // Alice is the creator → owner role.
  await expect(row).toContainText(/owner/i)
})
