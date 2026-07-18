import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Admin console — Projects tab shows Project column.
 *
 * AdminConsole.tsx has a "Projects" tab that renders a table with columns:
 * Project, Org, Creator, Validated, Words, Status.
 *
 * This spec: creates a project, navigates to /admin, clicks Projects tab, and
 * verifies the "Project" column heading is visible.
 */
test("admin console Projects tab shows Project column", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `Admin Project ${Date.now()}`, source: "en", target: "fr" })

  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  // Click the Projects tab.
  const projectsTab = alice.getByRole("tab", { name: /^Projects$/i })
  await expect(projectsTab).toBeVisible({ timeout: 10_000 })
  await projectsTab.click()

  // Projects table with "Project" column header.
  await expect(alice.getByRole("columnheader", { name: /^Project$/i })).toBeVisible({
    timeout: 5_000,
  })
})
