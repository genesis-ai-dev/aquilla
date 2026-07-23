import { test, expect } from "../../helpers/multi-user"

/**
 * AdminConsole — Tenants tab.
 *
 * AdminConsole.tsx renders a tab bar with TABS = [overview, tenants, people, projects, activity, platform].
 * The "Tenants" tab shows a table with columns: Organization, Owner, Members, Projects, Teams, Created.
 *
 * This spec: navigate to /admin → click "Orgs" tab → verify "Owner" column header appears.
 */
test("admin console Orgs tab shows Orgs table", async ({ alice }) => {
  await alice.goto("/admin")
  const tenantsTab = alice.getByRole("tab", { name: /^Tenants$/i })
  await expect(tenantsTab).toBeVisible({ timeout: 10_000 })
  await tenantsTab.click()

  // Verify the "Owner" column header appears (orgs table).
  await expect(alice.getByRole("columnheader", { name: /Owner/i })
    .or(alice.locator("th").filter({ hasText: /Owner/i })).first()
  ).toBeVisible({ timeout: 5_000 })
})
