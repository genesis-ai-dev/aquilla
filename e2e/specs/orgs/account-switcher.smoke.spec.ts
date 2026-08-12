import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState, injectSessions } from "../../helpers/auth"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

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
  const seeded = await seedProjectWithFile(await jwtFor("alice"), {
    name: `Preferences modal ${Date.now()}`,
  })
  await openSeededProject(alice, seeded)
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

  // Preferences opens over the current app route, so changing a personal
  // setting does not tear down the workspace behind it.
  const preferencesItem = alice.getByRole("menuitem", { name: /Preferences/i })
  await expect(preferencesItem).toBeVisible({ timeout: 3_000 })
  const backgroundUrl = alice.url()
  await preferencesItem.click()
  await expect(alice).toHaveURL(/\/preferences$/)
  const preferencesDialog = alice.getByTestId("preferences-dialog")
  await expect(preferencesDialog).toBeVisible()
  await expect(preferencesDialog.locator("h1").filter({ hasText: "Preferences" })).toBeVisible()

  await preferencesDialog.getByRole("link", { name: /Appearance/i }).click()
  await expect(alice).toHaveURL(/\/preferences\/appearance$/)
  await expect(preferencesDialog.getByRole("heading", { name: "Appearance" })).toBeVisible()

  await preferencesDialog.getByRole("button", { name: "Close" }).click()
  await expect(alice).toHaveURL(backgroundUrl)
  await expect(preferencesDialog).not.toBeVisible()
  await expect(accountBtn).toBeVisible()
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
  await expect(alice.getByText("bob", { exact: true })).toBeVisible({ timeout: 3_000 })
  await alice.getByRole("menuitem", { name: /^Log out$/i }).click()

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
