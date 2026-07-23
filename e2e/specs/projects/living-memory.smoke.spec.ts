import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

/**
 * Living memory page smoke test.
 *
 * The page at /project/:id/memory renders three sections:
 *   1. Instructions (authored guidance entries, kind="instruction")
 *   2. Standards    (authored standards entries, kind="standard")
 *   3. Recent Examples (validated translations, served from D1)
 *
 * This spec confirms the route loads without crashing and both authored
 * sections are present. It does NOT test: adding entries, persisting, or
 * the Recent Examples content (which requires seeded validated cells).
 */
test("living memory page renders Instructions and Standards sections", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Memory ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })

  // Extract project ID from the URL after create.
  await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
  const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
  expect(projectId, "should extract project ID from URL").toBeTruthy()

  // Navigate to the living memory page.
  await alice.goto(`/project/${projectId}/memory`)
  // Both authored sections render as <section aria-label="…">.
  // A fresh project has no authored entries but the section containers still render.
  const instructionsSection = alice.locator('section[aria-label="Instructions"]')
  const standardsSection = alice.locator('section[aria-label="Standards"]')

  await expect(instructionsSection).toBeVisible({ timeout: 10_000 })
  await expect(standardsSection).toBeVisible({ timeout: 5_000 })

  // The Recent Examples section is also rendered (may show "no examples" state).
  await expect(alice.locator('section[aria-label="Recent Examples"]')).toBeVisible({ timeout: 5_000 })
})
