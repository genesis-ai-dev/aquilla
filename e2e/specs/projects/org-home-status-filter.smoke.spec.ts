import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * OrgHome — project status filter select.
 *
 * OrgHome.tsx renders a shadcn Select (aria-label="Project status filter") for:
 *   All, Stalled, Overdue, Needs attention
 * The "All" filter is selected by default.
 * Choosing a filter option updates the trigger and filters the project list.
 *
 * OrgHome renders at "/" (org Overview) — /projects is the ProjectsList,
 * which has no status pills — and the select only renders once the org has
 * at least one project, so this spec creates one first.
 *
 * This spec: creates a project → navigates to the org home ("/") →
 * verifies "All" is selected → picks "Needs attention" → verifies the trigger
 * updates → picks "All" to restore.
 */
test("org home status filter select changes active value", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  await dash.createProject({ name: `StatusFilter ${Date.now()}` })

  await alice.goto("/")
  const statusFilter = alice.getByRole("combobox", { name: /project status filter/i })
  await expect(statusFilter).toBeVisible({ timeout: 10_000 })
  await expect(statusFilter).toContainText(/^All/i)

  await statusFilter.click()
  const attentionOption = alice.getByRole("option", { name: /^Needs attention$/i })
  await expect(attentionOption).toBeVisible({ timeout: 3_000 })
  await attentionOption.click()

  await expect(statusFilter).toContainText(/Needs attention/i, { timeout: 3_000 })

  await statusFilter.click()
  const allOption = alice.getByRole("option", { name: /^All$/i })
  await expect(allOption).toBeVisible({ timeout: 3_000 })
  await allOption.click()
  await expect(statusFilter).toContainText(/^All/i, { timeout: 3_000 })
})
