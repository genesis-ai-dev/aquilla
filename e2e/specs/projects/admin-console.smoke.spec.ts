import { test, expect } from "../../helpers/multi-user"

/**
 * Admin console (/admin) — tabs and overview stats.
 *
 * AdminConsole.tsx renders tabs: Overview, Orgs, Teams, Users, Projects, Activity.
 * The Overview tab shows stat cards for Orgs, Teams, Users, Active projects, etc.
 * Switching to the Orgs tab renders a table with columns Org/Owner/Members/Projects.
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

  // Switch to Orgs tab.
  const orgsTab = alice.getByRole("button", { name: /^Orgs$/i })
  await expect(orgsTab).toBeVisible({ timeout: 5_000 })
  await orgsTab.click()

  // Orgs table header appears.
  await expect(alice.getByText(/^Org$/i).first()).toBeVisible({ timeout: 5_000 })
})
