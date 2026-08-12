import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace "Settings" action navigates to project settings.
 *
 * "Settings" lives in the sidebar project-nav overflow (SidebarProjectSection):
 * unpinned nav items collapse into a popover behind the button labelled
 * "More project options". Clicking the Settings row calls:
 *   window.location.assign(buildProjectSettingsHandoffUrl({...}))
 * which navigates to `/project/:id/settings?return=...`.
 *
 * This spec: import a file → open the sidebar "More project options" popover →
 * click "Settings" → verify the URL changes to /project/:id/settings.
 */
test("sidebar More project options Settings item navigates to project settings", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `WsSettings ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Get current project ID from URL.
  const projectId = alice.url().match(/\/project\/([^/?]+)/)?.[1]
  expect(projectId).toBeTruthy()

  // Open the sidebar project-nav overflow popover.
  const moreBtn = alice.getByRole("button", { name: /^More project options$/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  // Click the "Settings" row (plain button inside the portaled popover).
  const settingsItem = alice.getByRole("button", { name: /^Settings$/i })
  await expect(settingsItem).toBeVisible({ timeout: 3_000 })
  await settingsItem.click()

  // Should navigate to /project/:id/settings.
  await alice.waitForURL(/\/project\/[^/]+\/settings/, { timeout: 5_000 })
  expect(alice.url()).toContain("/settings")
  expect(alice.url()).toMatch(/[?&]return=/)

  // Editor handoff: the breadcrumb includes Editor so the user can return.
  const breadcrumb = alice.getByRole("navigation", { name: /breadcrumb/i })
  await expect(breadcrumb.getByText("Editor", { exact: true })).toBeVisible()
  await expect(breadcrumb.getByText("Settings", { exact: true })).toBeVisible()
})
