import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * OrgHome project filter input.
 *
 * OrgHome.tsx renders an input (aria-label="Filter projects by name",
 * placeholder="Filter projects…") that filters the project grid client-side.
 *
 * This spec: creates two projects with distinct names → types one project's
 * name in the filter → verifies only that project is visible and the other
 * is hidden → clears the filter → both appear again.
 */
test("org home project filter shows only matching projects", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  const nameA = `FilterAlpha ${Date.now()}`
  const nameB = `FilterBeta ${Date.now()}`

  await dash.createProject({ name: nameA })
  await dash.goto()
  await dash.createProject({ name: nameB })

  // Navigate to org home (/ redirects to /projects; org home may be at / or /projects).
  await alice.goto("/")
  // Filter input.
  const filterInput = alice.getByRole("textbox", { name: /Filter projects/i })
    .or(alice.locator('input[aria-label="Filter projects by name"]'))
    .first()
  await expect(filterInput.first()).toBeVisible({ timeout: 10_000 })

  // Type nameA (distinct prefix).
  await filterInput.first().fill("FilterAlpha")

  // nameA visible, nameB hidden.
  await expect(alice.getByText(nameA).first()).toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(nameB)).not.toBeVisible({ timeout: 3_000 })

  // Clear filter → both visible.
  await filterInput.first().fill("")
  await expect(alice.getByText(nameA).first()).toBeVisible({ timeout: 5_000 })
  await expect(alice.getByText(nameB).first()).toBeVisible({ timeout: 5_000 })
})
