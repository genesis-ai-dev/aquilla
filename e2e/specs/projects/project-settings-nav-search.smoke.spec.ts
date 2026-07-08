import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectSettings — search filter (AQU-501).
 *
 * AQU-501 replaced the flat scroll-spy section list with a sub-menu index,
 * but the search box (SettingsNav, `aria-label="Search settings"`) still
 * filters across every section regardless of which pane is open — typing a
 * matching query renders the matching section(s) directly (e.g. the "Project
 * Info" card), and a non-matching query shows "No matching settings."
 *
 * This spec: navigate to project settings → type a gibberish query → verify
 * "No matching settings." appears → clear the input → type a real query →
 * verify the matching section's card renders.
 */
test("project settings search filters and clears sections", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `NavSearch ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/settings`)
  await alice.waitForLoadState("networkidle")

  const searchInput = alice.locator('input[aria-label="Search settings"]')
  await expect(searchInput).toBeVisible({ timeout: 10_000 })

  // Type a non-matching query.
  await searchInput.fill("xyzzy-no-match-gibberish")
  await expect(alice.getByText(/No matching settings/i)).toBeVisible({ timeout: 3_000 })

  // Clear the input — the settings index (sub-menu list) returns.
  await searchInput.fill("")
  await expect(alice.getByText(/No matching settings/i)).not.toBeVisible({ timeout: 3_000 })
  await expect(alice.getByRole("link", { name: /General/i })).toBeVisible({ timeout: 3_000 })

  // Type a query matching a specific section — its card renders directly,
  // regardless of which sub-menu group it lives in.
  await searchInput.fill("project info")
  await expect(alice.locator("#section-project-info")).toBeVisible({ timeout: 3_000 })
})
