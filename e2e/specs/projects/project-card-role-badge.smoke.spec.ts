import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectCard — "Your role on this project" role badge.
 *
 * ProjectCard.tsx renders a small pill badge when `myRoleLabel` is set
 * and the project isn't trashed:
 *   <span title="Your role on this project">{role}</span>
 *
 * For alice (who creates the project), the role is "owner".
 * The badge appears in the card header next to the project name.
 *
 * This spec: creates a project → verifies the role badge with
 * title="Your role on this project" is visible and shows "owner".
 */
test("project card shows Your role on this project badge for project owner", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `RoleBadge ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // After project creation, navigate back to dashboard.
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // The project card should show the role badge.
  const roleBadge = alice.locator('[title="Your role on this project"]').first()
  await expect(roleBadge).toBeVisible({ timeout: 10_000 })
  // Alice is the creator → owner role.
  await expect(roleBadge).toContainText(/owner/i)
})
