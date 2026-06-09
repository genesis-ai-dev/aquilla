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

  // The Teams table shows "Team" as the first column header.
  await expect(alice.getByText(/^Team$/)).toBeVisible({ timeout: 5_000 })
})
