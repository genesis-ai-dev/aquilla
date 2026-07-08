import { test, expect } from "../../helpers/multi-user"

/**
 * Admin console — People tab renders User column.
 *
 * AdminConsole.tsx has a "People" tab that renders a table with columns:
 * User, Email, Orgs, Last active, Joined.
 *
 * This spec: navigates to /admin → clicks Users tab → verifies the
 * "Username" column heading is visible.
 */
test("admin console Users tab shows Username column", async ({ alice }) => {
  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  const peopleTab = alice.getByRole("tab", { name: /^People$/i })
  await expect(peopleTab).toBeVisible({ timeout: 10_000 })
  await peopleTab.click()

  await expect(alice.getByRole("columnheader", { name: /^User$/i }).first()).toBeVisible({ timeout: 5_000 })
})
