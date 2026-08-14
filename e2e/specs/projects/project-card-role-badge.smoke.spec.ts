import { test, expect, orgRoute } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Org Projects table — per-project role label for the signed-in user.
 *
 * Each project row shows the user's role name next to the project name
 * (sortable via the "Role" column header). For alice (who creates the
 * project), the role is "owner" (auth-worker ROLE_NAMES[700]).
 *
 * This spec: creates a project → verifies its row in the projects list
 * shows the "owner" role label.
 */
test("project card shows Your role on this project badge for project owner", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RoleBadge ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // After project creation, navigate back to the org Projects table.
  await alice.goto(orgRoute(alice, "/projects"))
  const row = alice.getByRole("row").filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 10_000 })
  // Alice is the creator → owner role.
  await expect(row).toContainText(/owner/i)
})
