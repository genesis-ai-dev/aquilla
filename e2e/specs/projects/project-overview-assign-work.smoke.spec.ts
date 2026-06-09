import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ProjectOverview — Assign work form.
 *
 * ProjectOverview.tsx renders the AssignWork component (when the project has
 * files and the user is canManage). The component:
 *   - Shows an "Assign…" button (collapsed).
 *   - Clicking opens an inline form (role="group" aria-label="Assign work")
 *     with a file/chapter picker and member select.
 *   - "Cancel" collapses back to the "Assign…" button.
 */
test("project overview assign work form opens and Cancel collapses it", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AssignWork ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Import a file so the assign picker has files to show.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to the project overview.
  await alice.goto(`/projects/${projectId}`)
  await alice.waitForLoadState("networkidle")

  // "Assign…" button is visible.
  const assignBtn = alice.getByRole("button", { name: /^Assign…$/i })
  await expect(assignBtn).toBeVisible({ timeout: 10_000 })
  await assignBtn.click()

  // Inline form opens with aria-label "Assign work".
  const form = alice.locator('[role="group"][aria-label="Assign work"]')
  await expect(form).toBeVisible({ timeout: 3_000 })

  // Cancel collapses it.
  const cancelBtn = form.getByRole("button", { name: /^Cancel$/i })
  await expect(cancelBtn).toBeVisible({ timeout: 3_000 })
  await cancelBtn.click()
  await expect(form).not.toBeVisible({ timeout: 2_000 })
  await expect(assignBtn).toBeVisible({ timeout: 2_000 })
})
