import { test as base, expect, type Browser, type Page } from "@playwright/test"
import { resetBackend } from "./seed"
import { ensureAuthState, injectSession } from "./auth"

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
