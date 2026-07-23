import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * LivingMemoryPage — empty state for a fresh project.
 *
 * When no cells have been validated, the Recent Examples section renders
 * LivingMemoryEmpty with:
 *   - aria-label="No validated translations"
 *   - Text "No validated translations yet"
 *
 * The page header also shows a "0 validated" badge (cells.length.toLocaleString()
 * + " validated").
 *
 * This spec: navigate to a fresh project's /memory page → verify the empty
 * state text is shown in the Recent Examples section → verify the "0 validated"
 * badge appears.
 */
test("living memory Recent Examples shows empty state for fresh project", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MemEmpty ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/memory`)
  // Recent Examples section is visible.
  const recentSection = alice.locator('section[aria-label="Recent Examples"]')
  await expect(recentSection).toBeVisible({ timeout: 10_000 })

  // Empty state: "No validated translations yet" text.
  await expect(
    recentSection.getByText(/No validated translations yet/i)
  ).toBeVisible({ timeout: 5_000 })

  // Page header badge shows "0 validated".
  await expect(alice.getByText(/0 validated/i)).toBeVisible({ timeout: 5_000 })
})
