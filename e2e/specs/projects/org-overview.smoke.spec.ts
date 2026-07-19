import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Org overview (OrgHome at "/").
 *
 * The page shows:
 *  - Org name heading (h1)
 *  - Rollup strip: Projects / Avg translated / Avg validated / Avg audio /
 *    Stalled / Overdue tiles
 *  - Filter bar (input + status filter buttons) when projects exist
 *  - Project cards linking to /projects/:id
 *
 * We create a project first so the portfolio API has at least one entry,
 * guaranteeing the filter bar renders.
 */
test("org overview renders rollup stats and project filter", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()

  // Create a project so the portfolio has at least one entry.
  const name = `Overview ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Navigate to the org home.
  await alice.goto("/")
  await alice.waitForLoadState("networkidle")

  // 1. Org name heading (h1) renders.
  await expect(alice.locator("h1").first()).toBeVisible({ timeout: 10_000 })

  // 2. Rollup stats strip — each tile has a label in a small paragraph.
  for (const label of ["Projects", "Avg translated", "Avg validated", "Avg audio"]) {
    await expect(alice.getByText(label).first()).toBeVisible({ timeout: 5_000 })
  }

  // 3. Filter bar — visible when projects exist.
  const filterInput = alice.locator('input[aria-label="Filter projects by name"]')
  await expect(filterInput).toBeVisible({ timeout: 5_000 })

  // 4. Status filter buttons (All / Stalled / Overdue / Needs attention).
  await expect(alice.getByRole("button", { name: "All" }).first()).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("button", { name: "Stalled" }).first()).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("button", { name: "Overdue" }).first()).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("button", { name: "Needs attention" }).first()).toBeVisible({ timeout: 3_000 })

  // 5. The new project's card is visible.
  await expect(alice.getByText(name).first()).toBeVisible({ timeout: 5_000 })
})
