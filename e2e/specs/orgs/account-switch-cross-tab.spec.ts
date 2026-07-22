import { test, expect } from "../../helpers/multi-user"
import { ensureAuthState, injectAdditionalSession } from "../../helpers/auth"

/**
 * FRO-367: switching accounts in one tab reconciles every other tab.
 *
 * The session lives in IndexedDB, which emits no cross-tab events, so signing
 * into account B in one tab used to leave every other tab showing account A —
 * and its org switcher listing orgs the now-active account can't access —
 * until a manual reload. session-store now pings a localStorage key on every
 * write; other tabs hear the `storage` event and re-read.
 *
 * Two PAGES in ONE context (shared IDB + localStorage) — not the `bob`
 * fixture, which would be a separate context that can't share storage.
 */
test("switching account in one tab updates the other tab without a reload", async ({ alice }) => {
  // Alice is signed in and active in this context. Add bob as a second
  // account (present but not active), so the switcher lists him.
  const bob = await ensureAuthState("bob")
  await alice.goto("/projects")
  await injectAdditionalSession(alice, bob)

  // Tab B: a second page in the SAME context — shares the IDB envelope and
  // localStorage, so it boots as alice too.
  const tabB = await alice.context().newPage()
  await tabB.goto("/projects")
  await expect(tabB.getByRole("button", { name: /Account menu: alice/i })).toBeVisible({ timeout: 10_000 })

  // Tab A: open the account menu and switch to bob. Since 2ce62ce4d the menu
  // lists accounts directly (no "Switch to" section label) — click bob's entry.
  await alice.getByRole("button", { name: /Account menu: alice/i }).click()
  await alice.getByRole("menuitem", { name: /bob/i }).click()
  await expect(alice.getByRole("button", { name: /Account menu: bob/i })).toBeVisible({ timeout: 10_000 })

  // Tab B reconciles to bob WITHOUT any reload/navigation — the core of the
  // fix. (Before FRO-367 this stayed "alice" until a manual refresh.)
  await expect(tabB.getByRole("button", { name: /Account menu: bob/i })).toBeVisible({ timeout: 10_000 })
  await expect(tabB.getByRole("button", { name: /Account menu: alice/i })).toHaveCount(0)

  await tabB.close()
})
