import { test, expect } from "../../helpers/multi-user"

/**
 * DevLogoutRoute — /__dev/logout is gated on import.meta.env.DEV.
 *
 * DevLogoutRoute.tsx is a dev-only helper. Under `vite dev` it calls logout()
 * and redirects to /onboarding. In any BUILD (including the e2e harness, which
 * serves `vite build --mode test` + `vite preview` since 92e49c0f7),
 * import.meta.env.DEV is false, so the route must NOT log the user out —
 * it redirects to "/" with the session intact.
 *
 * The original dev-mode scenario (logout → /onboarding) is untestable against
 * the preview harness; what we CAN and must verify here is the production
 * gate: navigating to /__dev/logout in a built app is a harmless no-op.
 *
 * This spec:
 *   1. Alice is already authenticated (via the multi-user fixture).
 *   2. Navigate to /__dev/logout.
 *   3. Wait for redirect to "/" (the !DEV branch).
 *   4. Verify alice is still signed in (dashboard renders with her account).
 */
test("/__dev/logout is a no-op in built apps: redirects to / with session intact", async ({ alice }) => {
  // Navigate to the dev logout route.
  await alice.goto("/__dev/logout")

  // The !import.meta.env.DEV branch redirects to "/" without logging out.
  await alice.waitForURL(/\/$/, { timeout: 10_000 })

  // Alice must still be signed in — the org dashboard renders with her
  // account button (logout did NOT run).
  const page = alice
  await expect(page.getByRole("button", { name: /alice/i }).first()).toBeVisible({ timeout: 5_000 })
  // And we are NOT on the onboarding wizard.
  await expect(page.getByRole("main", { name: /Account setup/i })).not.toBeVisible()
})
