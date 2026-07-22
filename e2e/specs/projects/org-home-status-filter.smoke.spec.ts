import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * OrgHome — project status filter pills.
 *
 * OrgHome.tsx renders pill-style filter buttons (aria-pressed) for:
 *   All, Stalled, Overdue, Needs attention
 * The "All" filter is selected by default (aria-pressed="true").
 * Clicking a filter pill sets aria-pressed="true" on it.
 *
 * OrgHome renders at "/" (org Overview) — /projects is the ProjectsList,
 * which has no status pills — and the pills only render once the org has
 * at least one project, so this spec creates one first.
 *
 * This spec: creates a project → navigates to the org home ("/") →
 * verifies "All" is pressed → clicks "Needs attention" → verifies it becomes
 * pressed and "All" un-pressed → clicks "All" to restore.
 */
test("org home status filter pills toggle active state", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `StatusFilter ${Date.now()}` })

  await alice.goto("/")
  // "All" filter is pressed by default.
  const allBtn = alice.getByRole("button", { name: /^All$/i })
  await expect(allBtn).toBeVisible({ timeout: 10_000 })
  await expect(allBtn).toHaveAttribute("aria-pressed", "true")

  // Needs attention is last in the pill order.
  const overdueBtn = alice.getByRole("button", { name: /^Overdue$/i })
  const attentionBtn = alice.getByRole("button", { name: /^Needs attention$/i })
  await expect(overdueBtn).toBeVisible({ timeout: 3_000 })
  await expect(attentionBtn).toBeVisible({ timeout: 3_000 })

  await attentionBtn.click()

  // "Needs attention" is now pressed; "All" is not.
  await expect(attentionBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(allBtn).toHaveAttribute("aria-pressed", "false")

  // Restore by clicking "All".
  await allBtn.click()
  await expect(allBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
})
