import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AdminConsole — Teams tab.
 *
 * AdminConsole.tsx has tabs: Overview, Users, Projects, Teams, Activity.
 * The Teams tab renders a Table with head ["Team", "Members", "Projects", "Created"].
 *
 * This spec: navigate to /admin → click "Teams" tab → verify the "Team"
 * column header is visible.
 */
test("admin console Teams tab renders Team column header", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  // Verify we are on the admin page.
  await expect(alice.getByRole("heading", { name: /Admin console/i })).toBeVisible({
    timeout: 10_000,
  })

  // Click the Teams tab.
  const teamsTab = alice.getByRole("button", { name: /^Teams$/i })
  await expect(teamsTab).toBeVisible({ timeout: 5_000 })
  await teamsTab.click()

  // The Teams table shows "Team" as a column header. Role-scoped + .first():
  // the table renders one header row per org section, so a bare getByText
  // trips strict mode.
  await expect(
    alice.getByRole("columnheader", { name: "Team" }).first(),
  ).toBeVisible({ timeout: 5_000 })
})
