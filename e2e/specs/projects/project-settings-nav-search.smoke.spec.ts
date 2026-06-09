import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — SettingsNav search filter.
 *
 * SettingsNav.tsx has an `aria-label="Search settings"` input that filters
 * the visible section links. Typing a non-matching query collapses the nav
 * to "No matching sections".
 *
 * This spec: navigate to project settings → focus the search input →
 * type a gibberish query → verify "No matching sections" appears →
 * clear the input → verify sections return.
 */
test("project settings nav search filters and clears sections", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NavSearch ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  // The SettingsNav search input.
  const searchInput = alice.locator('input[aria-label="Search settings"]')
  await expect(searchInput).toBeVisible({ timeout: 10_000 })

  // Type a non-matching query.
  await searchInput.fill("xyzzy-no-match-gibberish")

  // Nav collapses to "No matching sections".
  await expect(alice.getByText(/No matching sections/i)).toBeVisible({ timeout: 3_000 })

  // Clear the input — sections return.
  await searchInput.fill("")
  await expect(alice.getByText(/No matching sections/i)).not.toBeVisible({ timeout: 3_000 })

  // At least one section link should be visible again (e.g. "General").
  const nav = alice.locator('[aria-label="Settings sections"]')
  await expect(nav.getByRole("button", { name: /General/i })).toBeVisible({ timeout: 3_000 })
})
