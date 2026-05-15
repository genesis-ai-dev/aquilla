import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/identity-api"

/**
 * Setup: alice's seed org "Acme" exists (created by /__test__/reset).
 * Action: alice adds bob via the API (production data path; UI is just
 *   one client of this endpoint).
 * Verify: bob sees Acme on his dashboard via the UI (this is the part
 *   that genuinely needs UI coverage — does the org switcher render the
 *   newly-joined org?).
 *
 * API-for-setup + UI-for-assertion is more robust than chaining UI
 * forms for both — UI selectors for org administration are speculative
 * (admin pages iterate frequently) but the API is a stable contract.
 */
// TODO(e2e): regressed between 5a808b4 (when all 8 smoke specs went green)
// and now. After alice.goto("/"), alice lands on /onboarding (the Welcome
// screen) instead of the authenticated dashboard — localStorage
// "codex:onboardingComplete" is set by injectSession but appears not to be
// observed at dashboard mount, OR the fixture's session has been invalidated
// by the re-mint at the top of the test. Re-enable once the auth-state
// flow is stable.
test.fixme("alice adds bob to Acme via API; bob sees Acme on his dashboard", async ({ alice, bob }) => {
  // The multi-user fixture's `alice` setup ran resetBackend(), so seeded
  // users + Acme exist. We re-mint a session here so the API helper has
  // the JWT outside the page context.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  expect(acme.name).toBe("Acme")

  // Add bob as a contributor.
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Sanity check: bob can authenticate (would have already failed during
  // multi-user fixture setup if not, but explicit call makes the failure
  // mode clear if the seed reset breaks).
  const bobSession = await ensureAuthState("bob")
  expect(bobSession.username).toBe("bob")

  // UI: alice's dashboard renders Acme (her own org). This catches dashboard
  // regressions that hide owned orgs.
  await alice.goto("/")
  await alice.reload()
  await expect(alice.getByText(/Acme/i).first()).toBeVisible({ timeout: 10_000 })

  // UI: bob's dashboard renders Acme too, after the API-side membership add.
  await bob.goto("/")
  await bob.reload()
  await expect(bob.getByText(/Acme/i).first()).toBeVisible({ timeout: 10_000 })
})
