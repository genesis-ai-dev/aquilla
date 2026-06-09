import { test, expect } from "../../helpers/multi-user"

/**
 * Admin console — Projects tab shows Project column.
 *
 * AdminConsole.tsx has a "Projects" tab that renders a table with columns:
 * Project, Org, Creator, Validated, Words, Status.
 *
 * This spec: navigates to /admin → clicks Projects tab →
 * verifies the "Project" column heading is visible.
 */
test("admin console Projects tab shows Project column", async ({ alice }) => {
  await alice.goto("/admin")
  await alice.waitForLoadState("networkidle")

  // Click the Projects tab.
  const projectsTab = alice.getByRole("button", { name: /^Projects$/i })
  await expect(projectsTab).toBeVisible({ timeout: 10_000 })
  await projectsTab.click()

  // Projects table with "Project" column header.
  await expect(alice.getByText(/^Project$/i).first()).toBeVisible({ timeout: 5_000 })
})
