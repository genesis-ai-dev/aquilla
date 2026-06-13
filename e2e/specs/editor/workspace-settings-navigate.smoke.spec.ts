import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `WsSettings ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

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
})
