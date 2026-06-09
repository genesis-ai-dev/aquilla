import { test, expect } from "../../helpers/multi-user"

/**
 * DevLogoutRoute — /__dev/logout clears session and redirects to /onboarding.
 *
 * DevLogoutRoute.tsx is a dev-only helper (gated on import.meta.env.DEV).
 * Navigating to /__dev/logout calls logout() and then redirects to /onboarding.
 * This is used for quick round-trip auth testing without clearing DevTools storage.
 *
 * This spec:
 *   1. Alice is already authenticated (via the multi-user fixture).
 *   2. Navigate to /__dev/logout.
 *   3. Wait for redirect to /onboarding.
 *   4. Verify the onboarding page is shown (user is logged out).
 */
test("/__dev/logout clears session and redirects to /onboarding", async ({ alice }) => {
  // Navigate to the dev logout route.
  await alice.goto("/__dev/logout")

  // Should redirect to /onboarding after logout completes.
  await alice.waitForURL(/\/onboarding/, { timeout: 10_000 })

  // The onboarding page should be visible — look for a heading or sign-in prompt.
  const page = alice
  await expect(
    page.locator("h1, h2").filter({ hasText: /welcome|sign in|get started|create.*account|onboard/i }).first()
  ).toBeVisible({ timeout: 5_000 })
})
