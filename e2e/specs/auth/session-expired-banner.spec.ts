import { test, expect, type Page } from "@playwright/test"
import { resetBackend, seedUser } from "../../helpers/seed"

/**
 * AQU-293 / AQU-884: the session-expired banner journey.
 *
 * A user whose stored credential has gone stale (server 401s it) reloads the
 * app: the amber banner must appear over the org surface, survive client-side
 * navigation (AQU-884 — it used to be wiped by the boot redirect's pathname
 * change), be dismissible, and — the AQU-884 follow-up race — be gone after a
 * successful re-login even though components with lagging React state fire a
 * burst of 401s with the replaced JWT right after `finalizeSession()` lowers
 * the flag. That last assertion is the regression guard for the guarded
 * notifier (src/lib/frontier/session-expiry.ts): without it the banner
 * intermittently re-latched on top of a healthy dashboard.
 */

const alice = seedUser("alice")

const banner = (page: Page) => page.getByRole("alert").filter({ hasText: /session expired/i })

async function loginViaUi(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "Username or email" }).fill(alice.username)
  await page.getByRole("textbox", { name: "Password" }).fill(alice.password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

/** Post-login org-shell hydration is a multi-service boot — 30s watchdog. */
async function expectSignedInAsAlice(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/, { timeout: 30_000 })
  await expect(page.getByRole("button", { name: /Account menu: alice/i })).toBeVisible({
    timeout: 30_000,
  })
}

/** Corrupt the active session's JWT signature in IDB so the server 401s it. */
async function tamperStoredJwt(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("frontier", 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction("session", "readwrite")
      const store = tx.objectStore("session")
      const get = store.get("envelope")
      get.onerror = () => reject(get.error)
      get.onsuccess = () => {
        const env = get.result as {
          active: string | null
          sessions: Record<string, { jwt: string }>
        }
        if (!env?.active) { reject(new Error("no active session to tamper")); return }
        const s = env.sessions[env.active]
        const parts = s.jwt.split(".")
        parts[2] = parts[2].split("").reverse().join("")
        s.jwt = parts.join(".")
        const put = store.put(env, "envelope")
        put.onerror = () => reject(put.error)
        put.onsuccess = () => resolve()
      }
    }
  }))
}

test.beforeEach(async () => {
  await resetBackend()
})

test("dead credential raises the banner; it persists, dismisses, and re-login clears it", async ({ page }) => {
  test.setTimeout(120_000)
  // Sign in through the real UI so the session lands in IDB the same way a
  // user's would (auth hint cookie included).
  await page.goto("/login")
  await loginViaUi(page)
  await expectSignedInAsAlice(page)

  // Invalidate the stored credential and cold-boot the org surface with it.
  await tamperStoredJwt(page)
  await page.goto("/orgs/all")

  // The 401 from the orgs fetch latches the banner; the AQU-882 error card
  // coexists with it rather than replacing it.
  await expect(banner(page)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()

  // Dismiss lowers it; the next 401 (from the in-place Retry) re-raises it.
  await page.getByRole("button", { name: "Dismiss" }).click()
  await expect(banner(page)).toBeHidden()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(banner(page)).toBeVisible({ timeout: 10_000 })

  // AQU-884: client-side navigation must not wipe it — the banner's own
  // "Sign in again" link routes to /login without a reload.
  await banner(page).getByRole("link", { name: /sign in again/i }).click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible({ timeout: 10_000 })
  await expect(banner(page)).toBeVisible()

  // Re-login. finalizeSession() lowers the flag; the post-login render burst
  // still 401s with the replaced JWT, and the guarded notifier must drop
  // those stragglers instead of re-latching the banner.
  await loginViaUi(page)
  await expectSignedInAsAlice(page)
  await expect(banner(page)).toBeHidden()
})
