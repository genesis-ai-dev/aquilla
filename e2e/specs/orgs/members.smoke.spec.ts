import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, listMyOrgs, ROLE } from "../../helpers/frontier-api"

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
// Fixed: injectSession now also sets aq_hint=1 cookie (belt+suspenders with
// localStorage "codex:onboardingComplete") so App.tsx hasAuthHintCookie()
// check passes even when IDB write bypasses the normal writeEnvelope path.
test("alice adds bob to Acme via API; bob sees Acme in the org switcher", async ({ alice, bob }) => {
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
  await expect.poll(async () => (await listMyOrgs(bobSession.jwt)).map((org) => org.name)).toContain("Acme")

  // UI: alice's dashboard renders Acme (her own org). This catches dashboard
  // regressions that hide owned orgs.
  await alice.goto("/")
  await alice.reload()
  await expect(alice.getByText(/Acme/i).first()).toBeVisible({ timeout: 10_000 })

  // UI: bob keeps his current workspace active, but Acme must be available in
  // the organization switcher after the API-side membership add.
  await bob.goto("/")
  await bob.reload()
  const orgSwitcher = bob.locator('[data-tour="org-switcher"]')
  await orgSwitcher.getByRole("button").click()
  // The accessible name starts with the avatar initials ("AC"), so match the
  // organization name as a whole word instead of anchoring at the beginning.
  await expect(bob.getByRole("menuitem", { name: /\bAcme\b/i })).toBeVisible({ timeout: 10_000 })
})
