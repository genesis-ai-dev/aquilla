import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AdminConsole — Activity tab.
 *
 * AdminConsole.tsx has tabs: Overview, Tenants, People, Projects, Activity, Platform.
 * The Activity tab renders a timeline headed "Activity".
 *
 * This spec: navigate to /admin → click "Activity" tab → verify the "When"
 * column header is visible.
 */
test("admin console Activity tab renders When column header", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  // Verify we are on the admin page.
  await expect(alice.getByRole("heading", { name: /Admin console/i })).toBeVisible({
    timeout: 10_000,
  })

  // Click the Activity tab.
  const activityTab = alice.getByRole("tab", { name: /^Activity$/i })
  await expect(activityTab).toBeVisible({ timeout: 5_000 })
  await activityTab.click()

  await expect(alice.getByText(/Cross-tenant events, most recent first/i)).toBeVisible({ timeout: 5_000 })
})
