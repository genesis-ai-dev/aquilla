import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Workspace "Settings" action navigates to project settings.
 *
 * "Settings" is a cog beside Import in the workspace header
 * (`WorkspaceHeaderActions`). Clicking it calls:
 *   window.location.assign(buildProjectSettingsHandoffUrl({...}))
 * which navigates to `/project/:id/settings?return=...`.
 *
 * This spec: import a file → click the header Settings cog → verify the URL
 * changes to /project/:id/settings.
 */
test("workspace header Settings cog navigates to project settings", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `WsSettings ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // Get current project ID from URL.
  const projectId = alice.url().match(/\/project\/([^/?]+)/)?.[1]
  expect(projectId).toBeTruthy()

  await expect(alice.getByRole("button", { name: /^Share$/i })).toHaveCount(0)

  const settingsBtn = alice.getByRole("button", { name: /^Settings$/i })
  await expect(settingsBtn).toBeVisible({ timeout: 10_000 })
  await settingsBtn.click()

  // Should navigate to /project/:id/settings.
  await alice.waitForURL(/\/project\/[^/]+\/settings/, { timeout: 5_000 })
  expect(alice.url()).toContain("/settings")
  expect(alice.url()).toMatch(/[?&]return=/)

  // Editor handoff: the breadcrumb includes Editor so the user can return.
  const breadcrumb = alice.getByRole("navigation", { name: /breadcrumb/i })
  await expect(breadcrumb.getByText("Editor", { exact: true })).toBeVisible()
  await expect(breadcrumb.getByText("Settings", { exact: true })).toBeVisible()
})
