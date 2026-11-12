import type { Page, Route } from "@playwright/test"
import { test, expect } from "../../helpers/multi-user"
import {
  commitTargetServerSide,
  jwtFor,
  openSeededProject,
  seedProjectWithFile,
  type SeededProject,
} from "../../helpers/seed-project"
import { throttleNetwork } from "../../helpers/network-throttle"
import type { Workspace } from "../../helpers/page-objects/Workspace"

/**
 * AQU-1248 — Edit History on a slow, lossy connection.
 *
 * The Burmese team waits for each edit to appear in Edit History before moving
 * on, so a history load that fails once and then sits on "Couldn't load edit
 * history." stalls their verify cycle. Contract under test, on a 3G-like
 * connection (SPA → sync-worker history route → Postgres event log):
 *
 *   a. a load whose first attempts fail (transport failure, then a 503)
 *      retries on its own with backoff and fills the panel — nobody clicks
 *      Retry;
 *   b. when every attempt fails at the transport level (the sync worker is
 *      unreachable), the message names a network failure, and Retry still
 *      loads the history once the worker is back.
 *
 * The cell's history is committed server-side, so the browser's outbox holds
 * nothing for it and the drawer's only source is the failing read. In a dev
 * build React StrictMode mounts the drawer's effect twice, so the read can run
 * as two overlapping chains; the assertions hold either way, because without
 * a retry every chain's first attempt fails.
 */

const CELL_INDEX = 0
const VALUE = "history retry check"
const NETWORK_FAILURE = "Couldn't load edit history — network error. Check your connection."

interface Seeded {
  seeded: SeededProject
  ws: Workspace
}

async function openCellWithServerHistory(page: Page): Promise<Seeded> {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `History retry ${Date.now()}` })
  await commitTargetServerSide(jwt, seeded, seeded.cellIds[CELL_INDEX], VALUE, "alice")
  const ws = await openSeededProject(page, seeded)
  return { seeded, ws }
}

/** Route this cell's history reads through `handle`, recording each one. */
async function routeHistoryReads(
  page: Page,
  seeded: SeededProject,
  handle: (route: Route, attempt: number) => Promise<void>,
): Promise<{ attempts: () => number; stop: () => Promise<void> }> {
  const historyPath =
    `/api/v1/projects/${seeded.projectId}/files/${seeded.fileId}` +
    `/cells/${encodeURIComponent(seeded.cellIds[CELL_INDEX])}/history`
  const matches = (url: URL) => url.pathname === historyPath
  let attempts = 0
  const handler = async (route: Route) => {
    attempts += 1
    await handle(route, attempts)
  }
  await page.route(matches, handler)
  return { attempts: () => attempts, stop: () => page.unroute(matches, handler) }
}

test("a history load that fails twice on a slow connection fills the panel without Retry", async ({ alice }) => {
  const { seeded, ws } = await openCellWithServerHistory(alice)
  await throttleNetwork(alice)

  const reads = await routeHistoryReads(alice, seeded, async (route, attempt) => {
    if (attempt === 1) return route.abort("connectionreset")
    if (attempt === 2) {
      // The real reply's headers keep CORS intact, so the SPA sees the 503
      // rather than an opaque transport failure.
      const response = await route.fetch()
      return route.fulfill({ response, status: 503, body: "temporarily unavailable" })
    }
    return route.continue()
  })

  await ws.openHistoryDrawer(CELL_INDEX)
  // Readiness watchdog, not a pacing wait: two backoffs (0.5 s + 2 s) plus a
  // throttled round trip (~700 ms latency each way) outrun the shared 10 s
  // assertion budget on a slow machine.
  await expect(ws.historyEntry(VALUE)).toBeVisible({ timeout: 30_000 })
  await expect(ws.historyRetryButton()).toHaveCount(0)
  expect(reads.attempts(), "the panel filled from a retried read").toBeGreaterThanOrEqual(3)
})

test("a history load that cannot reach the sync worker names a network failure, and Retry recovers", async ({ alice }) => {
  const { seeded, ws } = await openCellWithServerHistory(alice)
  await throttleNetwork(alice)

  const reads = await routeHistoryReads(alice, seeded, (route) => route.abort("connectionrefused"))

  await ws.openHistoryDrawer(CELL_INDEX)
  // Watchdog as above: three attempts and both backoffs must finish first.
  await expect(alice.getByText(NETWORK_FAILURE)).toBeVisible({ timeout: 30_000 })
  expect(reads.attempts(), "every bounded attempt ran before giving up").toBeGreaterThanOrEqual(3)
  await expect(ws.historyEntry(VALUE)).toHaveCount(0)

  // The worker is reachable again: the manual Retry still loads the history.
  await reads.stop()
  await ws.historyRetryButton().click()
  await expect(ws.historyEntry(VALUE)).toBeVisible({ timeout: 30_000 })
  await expect(alice.getByText(NETWORK_FAILURE)).toHaveCount(0)
})
