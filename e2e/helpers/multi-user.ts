import { test as base, expect, type Browser, type Page } from "@playwright/test"
import { resetBackend } from "./seed"
import { ensureAuthState, injectSession } from "./auth"
import { getMyOrg } from "./frontier-api"

export interface AuthedPage extends Page {
  username: "alice" | "bob" | "carol"
}

interface Fixtures {
  alice: AuthedPage
  bob: AuthedPage
  carol: AuthedPage
}

async function makeAuthedPage(
  browser: Browser,
  username: "alice" | "bob" | "carol",
  baseURL?: string,
): Promise<AuthedPage> {
  const session = await ensureAuthState(username)
  const ctx = await browser.newContext()
  // alice is a platform admin in the e2e stack (PLATFORM_ADMINS:alice in
  // scripts/e2e-up.ts), so GET /api/v2/orgs returns *every* org in the tenancy
  // (viaPlatformAdmin), not just her memberships. Once a second user's personal
  // org exists (the bob/carol fixtures), her org list has >1 entry with no
  // active selection, so the app defaults to the "All organizations" aggregate
  // — which has no "+ New Project" button, hanging Dashboard.createProject()
  // until the test times out. Seed her own org as active so she lands on a
  // concrete org. Only alice needs this: bob/carol see multiple orgs only via
  // genuine memberships, where the all-orgs default is the correct, realistic
  // behavior (and orgs/members.smoke depends on it). The guard keeps this a
  // one-time default that in-test org switches can still override.
  if (username === "alice") {
    const ownOrg = await getMyOrg(session.jwt)
    await ctx.addInitScript((orgId) => {
      if (localStorage.getItem("org:active") == null) {
        localStorage.setItem("org:active", String(orgId))
      }
    }, ownOrg.id)
  }
  // RootRedirect (FRO-172) hard-replaces "/" with /homepage when the aq_hint
  // cookie is absent — always true for a fresh context — and that document
  // navigation destroys injectSession's evaluate mid-flight ("Execution
  // context was destroyed"). Pre-set the hint cookie so the SPA stays on "/"
  // while the session is seeded.
  await ctx.addCookies([
    { name: "aq_hint", value: "1", url: baseURL ?? "http://127.0.0.1:5173" },
  ])
  // FRO-244: the "Project setup" checklist auto-opens as a modal sheet on the
  // first workspace visit to any incomplete project, making the page inert.
  // Its localStorage key is per-project (codex.setupAutoShown.<id>) so it
  // can't be pre-seeded for projects a test creates later — patch getItem at
  // the context level so every project reads as already-shown. The checklist
  // feature itself stays reachable through its chip.
  await ctx.addInitScript(() => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = function (key: string) {
      if (typeof key === "string" && key.startsWith("codex.setupAutoShown.")) return "1"
      return orig.call(this, key)
    }
  })
  const page = await ctx.newPage()
  await page.goto("/")
  await injectSession(page, session)
  return Object.assign(page, { username }) as AuthedPage
}

/** Per-test backend reset + lazy pre-authenticated Pages.
 *
 * Backend reset runs before `alice` is instantiated. Tests using two or more
 * users always include `alice` first by convention; this avoids resetting the
 * DB twice when `alice` and `bob` are both requested.
 *
 * If a test needs `bob` or `carol` WITHOUT `alice`, it must call
 * `await resetBackend()` itself in a `beforeEach` block. */
export const test = base.extend<Fixtures>({
  alice: async ({ browser, baseURL }, use) => {
    await resetBackend()
    const page = await makeAuthedPage(browser, "alice", baseURL)
    await use(page)
    // Cleanup: close the context so we don't leak browser resources.
    await page.context().close()
  },
  bob: async ({ browser, baseURL }, use) => {
    const page = await makeAuthedPage(browser, "bob", baseURL)
    await use(page)
    await page.context().close()
  },
  carol: async ({ browser, baseURL }, use) => {
    const page = await makeAuthedPage(browser, "carol", baseURL)
    await use(page)
    await page.context().close()
  },
})

export { expect }
