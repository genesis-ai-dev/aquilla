import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * MembersMatrixView — "Sole Owner" concentration risk indicator.
 *
 * MembersMatrixView.tsx renders a `ProjectHeaderCell` for each project
 * in the drill-down view. When `ownerCount === 1` (only one org member
 * has the "owner" role on that project), a `<span>` with:
 *   title="Sole Owner — losing this person locks the project"
 * appears as a warning icon next to the project name.
 *
 * Since alice creates the project and no other members are added,
 * the project has exactly one owner → the concentration-risk indicator
 * should be visible in the members matrix drill-down view.
 *
 * This spec:
 *   1. Creates an org + a project (alice is sole owner).
 *   2. Navigates to /members.
 *   3. Clicks alice's row to open the drill-down.
 *   4. Verifies the Sole Owner indicator is present.
 */
test("members matrix shows Sole Owner indicator for single-owner project", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const projName = `SoleOwner ${Date.now()}`
  await dash.createProject({ name: projName, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Navigate to org members page.
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // The matrix table should be visible.
  const table = alice.locator("table, [role='table']").first()
  await expect(table).toBeVisible({ timeout: 10_000 })

  // Click alice's row to open the per-user project drill-down.
  const aliceRow = alice.locator('[title="Click to see project access breakdown"]').first()
  await expect(aliceRow).toBeVisible({ timeout: 5_000 })
  await aliceRow.click()

  // The drill-down panel should be visible.
  await alice.waitForTimeout(1000)

  // The "Sole Owner" warning indicator should appear for the project.
  const soleOwnerIndicator = alice.locator('[title="Sole Owner — losing this person locks the project"]')
  await expect(soleOwnerIndicator).toBeVisible({ timeout: 8_000 })
})
