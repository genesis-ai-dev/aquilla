import { test, expect } from "../../helpers/multi-user"
import { jwtFor, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `FileStats ${Date.now()}` })

  // Navigate to the project overview.
  await alice.goto(`/projects/${seeded.projectId}`)
  await alice.waitForLoadState("networkidle")

  // The Progress section should show a per-file stats row.
  const fileRow = alice.getByTestId("file-row").filter({ hasText: /sample/i }).first()
  await expect(fileRow).toBeVisible({ timeout: 15_000 })
  await expect(fileRow.getByLabel(/\d+ filled, \d+ approved, \d+ total cells, \d+ words/)).toBeVisible()
})
