import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Org settings page (/settings).
 *
 * The page renders:
 *   - h1 "Organization settings"
 *   - Navigation rows: Organization (identity, security, providers, monday),
 *     People & Projects (members, teams, archived)
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
  const overviewHeading = alice.locator("h1").first()
  await expect(overviewHeading).toBeVisible()

  // Delay the first lazy destination chunk. Ordinary org navigation should
  // retain the useful overview instead of replacing it with loading chrome.
  let releaseChunks!: () => void
  const chunkGate = new Promise<void>((resolve) => { releaseChunks = resolve })
  await alice.route("**/assets/app-chunk-*.js", async (route) => {
    await chunkGate
    await route.continue()
  })
  // Count only requests caused by the client-side transition; initial account
  // hydration legitimately loads the directory once.
  orgDirectoryRequests = 0
  try {
    await alice.getByRole("link", { name: "Settings", exact: true }).click()
    await expect(overviewHeading).toBeVisible()
    await expect(alice.getByText("Loading page", { exact: true })).toHaveCount(0)
  } finally {
    releaseChunks()
  }
  await expect(alice).toHaveURL(orgRoute(alice, "/settings"))
  // Main heading.
  await expect(alice.locator("h1").filter({ hasText: /Organization settings/i })).toBeVisible({
    timeout: 10_000,
  })

  // Identity nav row on the index.
  await expect(alice.getByRole("link", { name: /Identity/i })).toBeVisible({
    timeout: 5_000,
  })

  // AQU-485+: visibility and permission floors live on /settings/security.
  const securityLink = alice.getByRole("link", { name: /^Security/i })
  await expect(securityLink).toBeVisible({
    timeout: 5_000,
  })
  await securityLink.click()
  await expect(alice).toHaveURL(orgRoute(alice, "/settings/security"))
  await expect(alice.locator("h1").filter({ hasText: /^Security$/ })).toBeVisible({
    timeout: 10_000,
  })
  await expect(alice.getByText("Visibility", { exact: true })).toBeVisible()
  await expect(alice.getByText("Permissions", { exact: true })).toBeVisible()
  await expect(alice.getByLabelText(/who can view the roster/i)).toBeVisible()
  await expect(alice.getByLabelText(/who can export/i)).toBeVisible()
  expect(orgDirectoryRequests).toBe(0)
})
