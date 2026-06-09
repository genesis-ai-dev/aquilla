import { test, expect } from "../../helpers/multi-user"

/**
 * Admin console — Users tab renders Username column.
 *
 * AdminConsole.tsx has a "Users" tab that renders a table with columns:
 * Username, Email, Orgs, Last active, Joined.
 *
 * This spec: navigates to /admin → clicks Users tab → verifies the
 * "Username" column heading is visible.
 */
test("admin console Users tab shows Username column", async ({ alice }) => {
  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  // Click the Users tab.
  const usersTab = alice.getByRole("button", { name: /^Users$/i })
  await expect(usersTab).toBeVisible({ timeout: 10_000 })
  await usersTab.click()

  // Users table with "Username" column header.
  await expect(alice.getByText(/^Username$/i).first()).toBeVisible({ timeout: 5_000 })
})
