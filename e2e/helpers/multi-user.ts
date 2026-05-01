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
): Promise<AuthedPage> {
  const session = await ensureAuthState(username)
  const ctx = await browser.newContext()
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
  alice: async ({ browser }, use) => {
    await resetBackend()
    const page = await makeAuthedPage(browser, "alice")
    await use(page)
    // Cleanup: close the context so we don't leak browser resources.
    await page.context().close()
  },
  bob: async ({ browser }, use) => {
    const page = await makeAuthedPage(browser, "bob")
    await use(page)
    await page.context().close()
  },
  carol: async ({ browser }, use) => {
    const page = await makeAuthedPage(browser, "carol")
    await use(page)
    await page.context().close()
  },
})

export { expect }
