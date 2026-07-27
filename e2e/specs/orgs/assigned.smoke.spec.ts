import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Assigned to me (/assigned).
 *
 * AssignedToMe.tsx fetches open assignments for the active org.
 * In a fresh dev environment with no assignments the page shows:
 *   - h1 "Assigned to me"
 *   - paragraph "You have no open assignments."
 *
 * This spec verifies the route loads and the empty-state renders.
 */
test("assigned-to-me page renders empty state", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/assigned"))
  await expect(alice.locator("h1").filter({ hasText: /Assigned to me/i })).toBeVisible({
    timeout: 10_000,
  })

  await expect(
    alice.getByText(/You have no open assignments/i)
  ).toBeVisible({ timeout: 5_000 })
})
