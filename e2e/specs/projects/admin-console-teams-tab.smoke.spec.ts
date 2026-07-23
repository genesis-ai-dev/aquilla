import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * AdminConsole — nested Teams column.
 *
 * AdminConsole.tsx nests teams under the Tenants tab.
 *
 * This spec: navigate to /admin → click "Tenants" tab → verify the "Teams"
 * column header is visible.
 */
test("admin console Teams tab renders Team column header", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  await alice.goto("/admin")
  // Verify we are on the admin page.
  await expect(alice.getByRole("heading", { name: /Admin console/i })).toBeVisible({
    timeout: 10_000,
  })

  const tenantsTab = alice.getByRole("tab", { name: /^Tenants$/i })
  await expect(tenantsTab).toBeVisible({ timeout: 5_000 })
  await tenantsTab.click()

  // The Teams table shows "Team" as a column header. Role-scoped + .first():
  // the table renders one header row per org section, so a bare getByText
  // trips strict mode.
  await expect(
    alice.getByRole("columnheader", { name: "Teams" }).first(),
  ).toBeVisible({ timeout: 5_000 })
})
