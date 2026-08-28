import { test, expect, orgRoute } from "../../helpers/multi-user"
import { ensureAuthState, injectAdditionalSession } from "../../helpers/auth"
import { AccountSwitcherPage } from "../../helpers/page-objects/AccountSwitcher"
import { seedUser } from "../../helpers/seed"
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
  const switcher = new AccountSwitcherPage(alice)
  await switcher.openMenu("alice")
  const accountBtn = alice.getByRole("button", { name: /Account menu: alice/i })

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

  await preferencesDialog.getByRole("link", { name: /Workspace/i }).click()
  await expect(alice).toHaveURL(/\/preferences\/workspace$/)
  await expect(preferencesDialog.getByRole("heading", { name: "Workspace" })).toBeVisible()

  await preferencesDialog.getByRole("button", { name: "Close" }).click()
  await expect(alice).toHaveURL(backgroundUrl)
  await expect(preferencesDialog).not.toBeVisible()
  await expect(accountBtn).toBeVisible()
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

test("logout and second-user sign-in survive unavailable private storage", async ({ alice }) => {
  test.setTimeout(120_000)
  const bob = seedUser("bob")

  // Safari Private Browsing exposes OPFS but rejects getDirectory() with this
  // UnknownError. Install the same browser-level constraint before reloading
  // so every app module observes the private-storage behavior.
  await alice.context().addInitScript(() => {
    Object.defineProperty(navigator.storage, "getDirectory", {
      configurable: true,
      value: () => Promise.reject(new DOMException(
        "The operation failed for an unknown transient reason (e.g. out of memory).",
        "UnknownError",
      )),
    })
  })
  await alice.reload()

  await new AccountSwitcherPage(alice).logOutCurrentAccount("alice")
  await expect(alice.getByRole("button", { name: "Log in" })).toBeVisible({ timeout: 30_000 })

  await alice.goto("/orgs/all")
  await expect(alice.getByText("Sign in to see your workspace")).toBeVisible({ timeout: 30_000 })
  await alice.getByRole("link", { name: "Sign in" }).click()

  await alice.getByLabel("Username or email").fill(bob.username)
  await alice.getByRole("textbox", { name: "Password" }).fill(bob.password)
  await alice.getByRole("button", { name: "Sign in" }).click()

  await expect(alice.getByRole("button", { name: /Account menu: bob/i })).toBeVisible({
    timeout: 30_000,
  })
  await expect(alice.getByText(/couldn't safely finish switching accounts/i)).toHaveCount(0)
})
