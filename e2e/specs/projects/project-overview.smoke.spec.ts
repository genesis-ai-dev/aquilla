import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * ProjectOverview (/projects/:id).
 *
 * After creating a project, the dashboard navigates to /projects/:id.
 * The page renders:
 *   - h1 with the project name
 *   - h2 "Progress" section
 *   - "Open project" button linking to the workspace
 *
 * This spec verifies the overview renders correctly and the Open project
 * button navigates to the workspace.
 */
test("project overview renders name, progress section, and Open project button", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Overview ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // createProject navigates to /projects/:id.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  await alice.waitForLoadState("networkidle")

  // h1 — project name.
  await expect(
    alice.locator("h1").filter({ hasText: name })
  ).toBeVisible({ timeout: 10_000 })

  // h2 "Progress"
  await expect(
    alice.locator("h2").filter({ hasText: /Progress/i }).first()
  ).toBeVisible({ timeout: 5_000 })

  // "Open project" button navigates to the workspace.
  const openBtn = alice.getByRole("link", { name: /Open project/i })
    .or(alice.getByRole("button", { name: /Open project/i }))
  await expect(openBtn.first()).toBeVisible({ timeout: 5_000 })
  await openBtn.first().click()

  // Workspace URL: /project/:id
  await alice.waitForURL(/\/project\/[^/]+$/, { timeout: 10_000 })
  await expect(alice.locator('[aria-label="Filter files"]')).toBeVisible({ timeout: 5_000 })
})
