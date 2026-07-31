import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * OrgHome — project status filter tabs.
 *
 * OrgHome.tsx renders shadcn SegmentTabs for:
 *   All, Stalled, Overdue, Needs attention
 * The "All" filter is selected by default (aria-selected="true").
 * Clicking a filter tab selects it.
 *
 * OrgHome renders at "/" (org Overview) — /projects is the ProjectsList,
 * which has no status pills — and the tabs only render once the org has
 * at least one project, so this spec creates one first.
 *
 * This spec: creates a project → navigates to the org home ("/") →
 * verifies "All" is selected → clicks "Needs attention" → verifies it becomes
 * selected and "All" un-selected → clicks "All" to restore.
 */
test("org home status filter tabs toggle active state", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `StatusFilter ${Date.now()}` })

  await alice.goto("/")
  // "All" filter is selected by default.
  const allTab = alice.getByRole("tab", { name: /^All$/i })
  await expect(allTab).toBeVisible({ timeout: 10_000 })
  await expect(allTab).toHaveAttribute("aria-selected", "true")

  // Needs attention is last in the tab order.
  const overdueTab = alice.getByRole("tab", { name: /^Overdue$/i })
  const attentionTab = alice.getByRole("tab", { name: /^Needs attention$/i })
  await expect(overdueTab).toBeVisible({ timeout: 3_000 })
  await expect(attentionTab).toBeVisible({ timeout: 3_000 })

  await attentionTab.click()

  // "Needs attention" is now selected; "All" is not.
  await expect(attentionTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })
  await expect(allTab).toHaveAttribute("aria-selected", "false")

  // Restore by clicking "All".
  await allTab.click()
  await expect(allTab).toHaveAttribute("aria-selected", "true", { timeout: 3_000 })
})
