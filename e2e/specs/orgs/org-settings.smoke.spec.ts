import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Org settings page (/settings).
 *
 * The page renders:
 *   - h1 "Organization settings"
 *   - Navigation rows to identity, export, roster, providers, members, teams, archived
 *
 * This spec verifies the route loads and the key structural elements render.
 * It does NOT mutate org settings.
 */
test("org settings page renders Identity section and stats", async ({ alice }) => {
  let orgDirectoryRequests = 0
  alice.on("request", (request) => {
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname === "/api/v2/orgs") {
      orgDirectoryRequests += 1
    }
  })

  await alice.goto(orgRoute(alice))
  await expect(alice.getByRole("link", { name: "Settings", exact: true })).toBeVisible()
  // Count only requests caused by the client-side transition; initial account
  // hydration legitimately loads the directory once.
  orgDirectoryRequests = 0
  await alice.getByRole("link", { name: "Settings", exact: true }).click()
  await expect(alice).toHaveURL(orgRoute(alice, "/settings"))
  // Main heading.
  await expect(alice.locator("h1").filter({ hasText: /Organization settings/i })).toBeVisible({
    timeout: 10_000,
  })

  // Identity nav row on the index.
  await expect(alice.getByRole("link", { name: /Identity/i })).toBeVisible({
    timeout: 5_000,
  })

  // AQU-485: roster & progress visibility is a first-class settings sub-page.
  await expect(alice.getByRole("link", { name: /Roster & progress visibility/i })).toBeVisible({
    timeout: 5_000,
  })
  expect(orgDirectoryRequests).toBe(0)
})
