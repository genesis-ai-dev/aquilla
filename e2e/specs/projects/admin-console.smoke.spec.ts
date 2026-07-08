import { test, expect } from "../../helpers/multi-user"

/**
 * Admin console (/admin) — tabs and overview stats.
 *
 * AdminConsole.tsx renders tabs: Overview, Tenants, People, Projects, Activity, Platform.
 * The Overview tab shows stat cards for organizations, teams, users, active projects, etc.
 * Switching to the Tenants tab renders a table with Organization/Owner/Members/Projects/Teams.
 *
 * Alice is a superadmin in the test environment (seeded by test fixtures).
 * This spec: navigates to /admin → Overview tab shows stat headings →
 * clicks "Orgs" tab → table header "Org" appears.
 */
test("admin console loads overview and Orgs tab", async ({ alice }) => {
  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  // Overview stats should load — look for any of the stat labels.
  await expect(
    alice.getByText(/Orgs|Users|Active projects/i).first()
  ).toBeVisible({ timeout: 10_000 })

  const tenantsTab = alice.getByRole("tab", { name: /^Tenants$/i })
  await expect(tenantsTab).toBeVisible({ timeout: 5_000 })
  await tenantsTab.click()

  await expect(alice.getByRole("columnheader", { name: /^Organization$/i }).first()).toBeVisible({ timeout: 5_000 })
})
