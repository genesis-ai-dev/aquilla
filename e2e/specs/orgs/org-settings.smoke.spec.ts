import { test, expect } from "../../helpers/multi-user"

/**
 * Org settings page (/settings).
 *
 * The routed Identity detail page renders:
 *   - h2 "Identity" section
 *   - org name + current role
 *
 * This spec verifies the route loads and the key structural elements render.
 * It does NOT mutate org settings.
 */
test("org settings page renders Identity section and stats", async ({ alice }) => {
  await alice.goto("/settings/identity")
  await alice.waitForLoadState("networkidle")

  await expect(alice).toHaveURL(/\/settings\/identity$/)

  // Identity section heading.
  await expect(alice.getByRole("heading", { name: /^Identity$/i, level: 2 })).toBeVisible({
    timeout: 5_000,
  })
  await expect(alice.getByText(/Your role:\s*owner/i)).toBeVisible({ timeout: 5_000 })
})
