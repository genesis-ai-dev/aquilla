import {
  expect,
  request as pwRequest,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test"
import { injectSession, type PersistedSession } from "../../helpers/auth"
import { Workspace } from "../../helpers/page-objects/Workspace"
import {
  describeProductionTimingTarget,
  resolveProductionTimingTarget,
  type ProductionTimingTarget,
} from "../../helpers/production-target"

/**
 * AQU-1024 — production timing probe.
 *
 * Deployed-environment regressions in load and write latency are invisible to
 * the local suite: a `wrangler dev` stack has no cold Worker start, no
 * Hyperdrive hop, and a Postgres on the same machine. This spec drives a real
 * deployment as a real user and asserts the two numbers the team watches.
 *
 * It is NOT part of any local suite — `playwright.config.web.ts` ignores this
 * directory, and it runs only through `pnpm test:e2e:production:timing`, which
 * refuses to start until the target is configured. See `e2e/README.md`.
 */

const target: ProductionTimingTarget = resolveProductionTimingTarget(process.env)

/** Sign in through the same endpoint the SPA's own login form posts to. */
async function signIn(config: ProductionTimingTarget): Promise<PersistedSession> {
  const context = await pwRequest.newContext()
  try {
    const response = await context.post(`${config.authBase}/api/v2/auth/token`, {
      data: {
        username: config.username,
        password: config.password,
        migration_handshake: true,
      },
    })
    // The response body can echo account state, so report the status only.
    if (!response.ok()) {
      throw new Error(
        `production login for ${config.username} failed: HTTP ${response.status()}`,
      )
    }
    const auth = (await response.json()) as { access_token?: string }
    if (!auth.access_token) {
      throw new Error(`production login for ${config.username} returned no access_token`)
    }
    return {
      jwt: auth.access_token,
      username: config.username,
      createdAt: new Date().toISOString(),
    }
  } finally {
    await context.dispose()
  }
}

function report(label: string, measuredMs: number, budgetMs: number): string {
  const line = `${label} ${measuredMs}ms (budget ${budgetMs}ms)`
  test.info().annotations.push({ type: "timing", description: line })
  console.log(`[prod-timing] ${line}`)
  return line
}

// The write measurement reuses the workspace the load measurement opened, so
// the two tests share one page and must run in order.
test.describe.configure({ mode: "serial" })

test.describe("production timing probe", () => {
  let context: BrowserContext
  let page: Page
  let workspace: Workspace

  test.beforeAll(async ({ browser }) => {
    console.log(`[prod-timing] ${describeProductionTimingTarget(target)}`)
    context = await browser.newContext()
    page = await context.newPage()
    workspace = new Workspace(page)
    // injectSession writes the session envelope into IndexedDB, so the page
    // must already be on the app's origin.
    await page.goto(target.appOrigin)
    await injectSession(page, await signIn(target))
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test("opens the configured project workspace within the load budget", async () => {
    const startedAt = Date.now()
    await page.goto(`${target.appOrigin}/project/${target.projectId}/editor`)
    await workspace.waitForEditor()
    const loadMs = Date.now() - startedAt

    const line = report("workspace load", loadMs, target.loadBudgetMs)
    expect(loadMs, `${line} — exceeded`).toBeLessThanOrEqual(target.loadBudgetMs)
  })

  test("commits a target cell within the write budget", async () => {
    // The marker is timestamped so a failed run leaves evidence of when the
    // probe last wrote. The configured project exists for this and nothing
    // else — see resolveProductionTimingTarget's contract.
    const marker = `AQU-1024 timing probe ${Date.now()}`
    const writeMs = await workspace.replaceCellMeasuringCommit(0, marker)

    const line = report("cell write", writeMs, target.writeBudgetMs)
    expect(writeMs, `${line} — exceeded`).toBeLessThanOrEqual(target.writeBudgetMs)
  })
})
