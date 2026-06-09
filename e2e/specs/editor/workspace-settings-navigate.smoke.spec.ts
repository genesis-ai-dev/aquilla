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
 * The workspace header's "More actions" dropdown (PrimaryActionButton)
 * contains a "Settings" item. Clicking it calls:
 *   window.location.assign(buildProjectSettingsHandoffUrl({...}))
 * which navigates to `/project/:id/settings?return=...`.
 *
 * This spec: import a file → open the dropdown → click "Settings" →
 * verify the URL changes to /project/:id/settings.
 */
test("workspace More actions Settings item navigates to project settings", async ({ alice }) => {
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

  // Open the "More actions" dropdown.
  const moreBtn = alice.getByRole("button", { name: /More actions/i })
  await expect(moreBtn).toBeVisible({ timeout: 10_000 })
  await moreBtn.click()

  // Click "Settings" in the dropdown.
  const settingsItem = alice.getByRole("menuitem", { name: /^Settings$/i })
    .or(alice.getByText(/^Settings$/).first())
  await expect(settingsItem).toBeVisible({ timeout: 3_000 })
  await settingsItem.click()

  // Should navigate to /project/:id/settings.
  await alice.waitForURL(/\/project\/[^/]+\/settings/, { timeout: 5_000 })
  expect(alice.url()).toContain("/settings")
})
