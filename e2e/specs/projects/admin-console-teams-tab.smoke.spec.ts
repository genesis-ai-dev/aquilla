import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AdminConsole — Teams tab.
 *
 * AdminConsole.tsx has a Teams tab after Tenants with columns Team,
 * Organization, Members, Projects (or an empty panel when none exist).
 *
 * This spec: navigate to /admin → click "Teams" tab → verify the teams
 * surface is mounted (search toolbar when teams exist, empty copy otherwise).
 */
test("admin console Teams tab renders Team column header", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  await alice.goto("/admin")
  await expect(alice.getByRole("heading", { name: /Admin console/i })).toBeVisible({
    timeout: 10_000,
  })

  const teamsTab = alice.getByRole("tab", { name: /^Teams$/i })
  await expect(teamsTab).toBeVisible({ timeout: 5_000 })
  await teamsTab.click()

  await expect(
    alice.getByRole("columnheader", { name: /^Team$/i }).or(alice.getByText("No teams yet")),
  ).toBeVisible({ timeout: 5_000 })
})
