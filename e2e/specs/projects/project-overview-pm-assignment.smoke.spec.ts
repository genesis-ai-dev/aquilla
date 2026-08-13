import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Project manager assignment (AQU-507).
 *
 * ProjectOverview.tsx renders a "Project manager" card:
 *   - data-testid="overview-pm-name" shows the PM's username or "Unassigned"
 *   - data-testid="overview-pm-edit" opens the Assign/Change dialog
 *     (member Select + Save); a "Clear" button appears once a PM is set
 * The org Projects table (OrgProjectsDataTable) renders a "PM" column whose
 * values are joined from the OrgContext accessible-projects directory.
 *
 * The table half deliberately reaches Projects through in-app navigation
 * (sidebar "Projects" link / table row click), never page.goto: the directory
 * is fetched once per session, and a PM change must revalidate it so the
 * column updates without a reload (regression — before the fix on
 * agent-integration-2026-07-29, only a hard refresh showed the new PM).
 */
test("assign a PM on the project overview, org overview column updates without reload, clear returns Unassigned", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `PM Assign ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })

  // The fresh project starts unassigned.
  const pmName = alice.getByTestId("overview-pm-name")
  await expect(pmName).toHaveText("Unassigned", { timeout: 10_000 })

  // Assign alice (creator → effective member, so she's in the picker and
  // passes the server's membership check).
  await alice.getByTestId("overview-pm-edit").click()
  const dialog = alice.getByRole("dialog", { name: /Assign project manager/i })
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  await dialog.getByRole("combobox", { name: "Project manager" }).click()
  await alice.getByRole("option", { name: "alice", exact: true }).click()
  await dialog.getByRole("button", { name: /^Save$/ }).click()

  // Card shows the username; Clear appears alongside Change.
  await expect(pmName).toHaveText("alice", { timeout: 5_000 })
  await expect(alice.getByRole("button", { name: /^Clear$/ })).toBeVisible({ timeout: 3_000 })

  // Client-side navigate to the org Projects table — the PM column must show
  // the new PM without a page reload.
  await alice.getByRole("navigation").getByRole("link", { name: "Projects" }).click()
  await alice.waitForURL(/\/orgs\/\d+\/projects\/?$/, { timeout: 10_000 })
  const row = alice.locator("tr", { hasText: name })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.getByText("alice", { exact: true })).toBeVisible({ timeout: 5_000 })

  // Back to the project overview via the table row (still client-side), clear the PM.
  await row.getByText(name).click()
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 10_000 })
  await expect(pmName).toHaveText("alice", { timeout: 10_000 })
  // Unambiguous: the deadline card's own Clear only renders once a deadline
  // is set, and this test never sets one.
  await alice.getByRole("button", { name: /^Clear$/ }).click()
  await expect(pmName).toHaveText("Unassigned", { timeout: 5_000 })

  // The Projects table PM column returns to Unassigned — again without a reload.
  await alice.getByRole("navigation").getByRole("link", { name: "Projects" }).click()
  await alice.waitForURL(/\/orgs\/\d+\/projects\/?$/, { timeout: 10_000 })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.getByText("Unassigned", { exact: true })).toBeVisible({ timeout: 5_000 })
})

