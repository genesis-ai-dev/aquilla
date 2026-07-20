import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState, injectSessions } from "../../helpers/auth"

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
  const accountBtn = alice.getByRole("button", { name: /Account menu: alice/i })
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()

  // Dropdown opens showing the active account.
  await expect(alice.getByText(/alice/i).first()).toBeVisible({ timeout: 3_000 })

  // "Add another account…" button is visible.
  await expect(
    alice.getByRole("menuitem", { name: /Add another account/i })
  ).toBeVisible({ timeout: 3_000 })

  // "Preferences" link is visible.
  await expect(
    alice.getByRole("menuitem", { name: /Preferences/i })
  ).toBeVisible({ timeout: 3_000 })

  // Close by pressing Escape or clicking outside.
  await alice.keyboard.press("Escape")
})

test("logging out promotes another signed-in account", async ({ alice }) => {
  const [aliceSession, bobSession] = await Promise.all([
    ensureAuthState("alice"),
    ensureAuthState("bob"),
  ])

  await alice.goto(orgRoute(alice))
  await injectSessions(alice, [aliceSession, bobSession], "alice")

  const accountBtn = alice.getByRole("button", { name: /Account menu: alice/i })
  await expect(accountBtn).toBeVisible({ timeout: 10_000 })
  await accountBtn.click()
  await alice.getByRole("menuitem", { name: /^Log out$/i }).click()

  // After alice logs out, bob is promoted in IDB but the URL may still be
  // alice's org (OrgRouteGate shows "not found" with no account switcher).
  // /orgs/all always mounts the shell so the promoted account menu is visible.
  await alice.goto("/orgs/all")
  await alice.waitForLoadState("networkidle")

  await expect(alice.getByRole("button", { name: /Account menu: bob/i })).toBeVisible({
    timeout: 10_000,
  })
})
