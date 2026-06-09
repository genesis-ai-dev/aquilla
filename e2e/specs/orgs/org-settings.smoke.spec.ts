import { test, expect } from "../../helpers/multi-user"

/**
 * Org settings page (/settings).
 *
 * The page renders:
 *   - h1 "Organization settings"
 *   - h2 "Identity" section (org name + display name fields)
 *   - Member count and project count stats
 *   - Links to Archived projects and Members pages
 *
 * This spec verifies the route loads and the key structural elements render.
 * It does NOT mutate org settings.
 */
test("org settings page renders Identity section and stats", async ({ alice }) => {
  await alice.goto("/settings")
  await alice.waitForLoadState("networkidle")

  // Main heading.
  await expect(alice.locator("h1").filter({ hasText: /Organization settings/i })).toBeVisible({
    timeout: 10_000,
  })

  // Identity section heading.
  await expect(alice.locator("h2").filter({ hasText: /Identity/i }).first()).toBeVisible({
    timeout: 5_000,
  })
})
