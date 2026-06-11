import { test, expect } from "../../helpers/multi-user"

/**
 * User preferences (/preferences).
 *
 * Preferences.tsx renders:
 *   - h1 "Preferences"
 *   - h2 "Workspace" section with sidebar tab layout picker
 *   - h2 "Privacy" section with analytics toggle
 *
 * This spec verifies the route loads and the Privacy section renders.
 * It does NOT mutate any settings.
 */
test("preferences page renders Privacy section", async ({ alice }) => {
  await alice.goto("/preferences")
  await alice.waitForLoadState("networkidle")

  await expect(alice.locator("h1").filter({ hasText: /Preferences/i })).toBeVisible({
    timeout: 10_000,
  })

  await expect(alice.locator("h2").filter({ hasText: /Workspace/i }).first()).toBeVisible({
    timeout: 5_000,
  })

  await expect(alice.locator("h2").filter({ hasText: /Privacy/i }).first()).toBeVisible({
    timeout: 5_000,
  })
})
