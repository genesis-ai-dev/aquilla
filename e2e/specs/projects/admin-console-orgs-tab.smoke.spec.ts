import { test, expect } from "../../helpers/multi-user"

/**
 * AdminConsole — Orgs tab.
 *
 * AdminConsole.tsx renders a tab bar with TABS = [overview, orgs, teams, users, projects, activity].
 * The "Orgs" tab shows a table with columns: Org, Owner, Members, Projects, Created.
 *
 * This spec: navigate to /admin → click "Orgs" tab → verify "Owner" column header appears.
 */
test("admin console Orgs tab shows Orgs table", async ({ alice }) => {
  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  // Click "Orgs" tab button.
  const orgsTab = alice.getByRole("button", { name: /^Orgs$/i })
  await expect(orgsTab).toBeVisible({ timeout: 10_000 })
  await orgsTab.click()

  // Verify the "Owner" column header appears (orgs table).
  await expect(alice.getByRole("columnheader", { name: /Owner/i })
    .or(alice.locator("th").filter({ hasText: /Owner/i })).first()
  ).toBeVisible({ timeout: 5_000 })
})
