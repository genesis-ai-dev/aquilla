import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState, injectAdditionalSession } from "../../helpers/auth"
import { AccountSwitcherPage } from "../../helpers/page-objects/AccountSwitcher"

/**
 * AccountSwitcher dropdown — sidebar username button.
 *
 * The workspace sidebar (and org sidebar) has a button showing the current
 * username with a ChevronsUpDown icon. Clicking it opens a dropdown with:
 *   - Current user entry
 *   - "Preferences" link
 *   - "Add another account…" button
 *
 * This spec navigates to the org home and verifies the account switcher
 * renders and the dropdown opens.
 */
test("account switcher dropdown opens with session info", async ({ alice }) => {
  await alice.goto(orgRoute(alice))
  // The AccountSwitcher renders as a button showing the username.
  // Alice is seeded as "alice".
  const switcher = new AccountSwitcherPage(alice)
  await switcher.openMenu("alice")

  // Dropdown opens showing the active account.
  await expect(alice.getByText(/alice/i).first()).toBeVisible({ timeout: 3_000 })

  // "Add another account…" button is visible.
  await expect(
    alice.getByRole("menuitem", { name: /Add another account/i })
  ).toBeVisible({ timeout: 3_000 })

  // "Preferences" opens as a full page, not a route-backed modal.
  const preferencesItem = alice.getByRole("menuitem", { name: /Preferences/i })
  await expect(preferencesItem).toBeVisible({ timeout: 3_000 })
  await preferencesItem.click()
  await expect(alice).toHaveURL(/\/preferences$/)
  await expect(alice.getByRole("heading", { name: /Preferences/i })).toBeVisible()
  await expect(alice.getByTestId("preferences-dialog")).toHaveCount(0)
})

test("logging out promotes another signed-in account", async ({ alice }) => {
  // Alice is already the active session from the fixture. Merge bob in the
  // same way the working cross-tab spec does — overwriting the envelope
  // while the org page is live can lose the extra account to an in-flight
  // session-store write, so the menu never lists bob.
  const bobSession = await ensureAuthState("bob")
  await alice.goto(orgRoute(alice))
  await injectAdditionalSession(alice, bobSession)

  await new AccountSwitcherPage(alice).logOutCurrentAccount("alice", "bob")

  // handleLogout is async: wait until alice is gone and bob is active. Still on
  // alice's org URL, OrgRouteGate shows not-found (no account switcher) — that
  // flip is the signal the IDB promote finished before we navigate away.
  await expect(alice.getByRole("heading", { name: /Organization not found/i })).toBeVisible({
    timeout: 10_000,
  })

  await alice.goto("/orgs/all")

  await expect(alice.getByRole("button", { name: /Account menu: bob/i })).toBeVisible({
    timeout: 10_000,
  })
})
