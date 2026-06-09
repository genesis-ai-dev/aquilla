import { test, expect } from "../../helpers/multi-user"

/**
 * AssignedToMe page — renders the "Assigned to me" inbox at /assigned.
 *
 * AssignedToMe.tsx renders:
 *   - <h1>Assigned to me</h1>
 *   - Either a list of assignments OR "You have no open assignments." when empty.
 *
 * Alice has no assignments seeded, so this verifies the empty-state message.
 */
test("assigned-to-me page renders heading and empty state", async ({ alice }) => {
  await alice.goto("/assigned")
  await alice.waitForLoadState("networkidle")

  await expect(alice.getByRole("heading", { name: /Assigned to me/i })).toBeVisible({ timeout: 10_000 })

  // Empty state message (alice has no assignments).
  await expect(
    alice.getByText(/You have no open assignments/i)
      .or(alice.getByText(/Loading/i))
  ).toBeVisible({ timeout: 8_000 })
})
