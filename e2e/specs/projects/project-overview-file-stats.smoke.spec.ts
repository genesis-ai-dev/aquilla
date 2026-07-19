import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * ProjectOverview — per-file stats row.
 *
 * After files have been imported, ProjectOverview.tsx renders a list of
 * file rows in the Progress section. Each row exposes an accessible metric
 * group for filled, approved, total-cell, and word counts.
 *
 * This spec: creates a project, imports a file, navigates to /projects/:id
 * and verifies the stats row is visible.
 */
test("project overview shows per-file stats row after import", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `FileStats ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  // Import a file so the overview has data to show.
  await alice.goto(`/project/${projectId}/editor`)
  await alice.waitForLoadState("networkidle")
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)

  // Navigate to the project overview.
  await alice.goto(`/projects/${projectId}`)
  await alice.waitForLoadState("networkidle")

  // The Progress section should show a per-file stats row.
  const fileRow = alice.getByTestId("file-row").filter({ hasText: /sample/i }).first()
  await expect(fileRow).toBeVisible({ timeout: 15_000 })
  await expect(fileRow.getByLabel(/\d+ filled, \d+ approved, \d+ total cells, \d+ words/)).toBeVisible()
})
