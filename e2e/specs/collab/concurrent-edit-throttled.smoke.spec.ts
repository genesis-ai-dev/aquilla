import type { Page, Request, Route } from "@playwright/test"
import { test, expect } from "../../helpers/multi-user"
import { waitForProjectSyncReady } from "../../helpers/project-sync"
import { addProjectMember, ROLE } from "../../helpers/frontier-api"
import {
  jwtFor,
  seedProjectWithFile,
  openSeededProject,
  readProjectedCells,
  readCellHistory,
  type SeededProject,
} from "../../helpers/seed-project"
import { throttleNetwork } from "../../helpers/network-throttle"

/**
 * Two people edit the SAME cell at the same time on a 3G-like connection
 * (the 2026-09-03 group test that lost edits). Contract under test
 * (AQU-1154/AQU-1155 head compare-and-swap):
 *
 *   a. convergence — both browsers and the server projection agree on one
 *      value once both stop typing;
 *   b. no data loss — every value either user committed is in the cell's
 *      event log (winners on the chain, losers as bumped siblings);
 *   c. no ping-pong — the head stays put after quiescence;
 *   d. the bumped edit is discoverable in its author's history drawer and
 *      can be promoted back to current, after which everyone converges on it.
 *
 * Crosses SPA (two contexts) + sync-worker (events route, ProjectSync DO
 * lock/broadcast) + Postgres (projection + event log).
 *
 * Pacing is by observed state only: each typed value is followed by a wait
 * for the `POST /events` carrying exactly that value, so a value that never
 * left the browser (e.g. clobbered by a remote hydration before its idle
 * commit) fails loudly instead of silently shrinking the assertion set.
 */

const CELL_INDEX = 0
// Values are deliberately non-incremental of each other (length differs by
// more than 8) so the history drawer never collapses two of one author's
// commits into a single "session" card — each value gets its own card.
const ALICE_VALUES = ["alpha one", "alpha two revised wording", "alpha three"] as const
const BOB_VALUES = ["bravo one", "bravo two revised wording", "bravo three"] as const

interface CommitEvent {
  kind: string
  cellId?: string
  parentId?: string | null
  payload?: { value?: string }
}

function commitValuesIn(request: Request, cellId: string): string[] {
  if (request.method() !== "POST") return []
  try {
    if (!new URL(request.url()).pathname.endsWith("/events")) return []
  } catch {
    return []
  }
  const body = request.postDataJSON() as { events?: CommitEvent[] } | null
  return (body?.events ?? [])
    .filter((e) => e.kind === "target.cell.commit" && e.cellId === cellId)
    .map((e) => e.payload?.value)
    .filter((v): v is string => typeof v === "string")
}

/** Resolve when this page SENDS a commit carrying exactly `value` — the
 * idle-debounce commit leaving the browser, independent of the throttled
 * response time. */
function waitForCommitSent(page: Page, cellId: string, value: string): Promise<Request> {
  return page.waitForRequest(
    (request) => commitValuesIn(request, cellId).includes(value),
    { timeout: 10_000 },
  )
}

/** Every commit value each page posted for the cell, in send order. */
function recordCommits(page: Page, cellId: string): string[] {
  const seen: string[] = []
  page.on("request", (request) => seen.push(...commitValuesIn(request, cellId)))
  return seen
}

async function readHead(jwt: string, seeded: SeededProject, cellId: string) {
  const rows = await readProjectedCells(jwt, seeded, "target")
  const row = rows.find((r) => r.cellId === cellId)
  return row ? { value: row.value, eventId: row.eventId } : null
}

test("two users edit the same cell on a throttled network: converge, keep both edits, no ping-pong, bumped edit is promotable", async ({ alice, bob }) => {
  const aliceJwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(aliceJwt, { name: `Throttled ${Date.now()}` })
  await addProjectMember(aliceJwt, seeded.projectId, "bob", ROLE.CONTRIBUTOR)
  const cellId = seeded.cellIds[CELL_INDEX]

  // Both connected to the ProjectSync DO before anyone edits, so lock and
  // event.applied frames reach both.
  const aliceSync = waitForProjectSyncReady(alice, seeded.projectId)
  const aliceWs = await openSeededProject(alice, seeded)
  await aliceSync
  const bobSync = waitForProjectSyncReady(bob, seeded.projectId)
  const bobWs = await openSeededProject(bob, seeded)
  await bobSync

  const aliceSent = recordCommits(alice, cellId)
  const bobSent = recordCommits(bob, cellId)

  // Throttle only the edit phase (setup above ran at full speed). CDP shaping
  // covers HTTP — the outbox `POST /events` and the cells refetch — but NOT
  // the already-open ProjectSync WebSocket, so lock/presence/event.applied
  // frames still arrive in milliseconds. That is also why both editors cannot
  // be open at once here: the advisory lock reaches the second user before
  // their click. The compare-and-swap race lives on the slow HTTP path.
  const aliceNet = await throttleNetwork(alice)
  const bobNet = await throttleNetwork(bob)

  const users = {
    alice: { page: alice, ws: aliceWs },
    bob: { page: bob, ws: bobWs },
  } as const
  type User = keyof typeof users

  /** Wait until this user's row shows the server's current head. Before a
   * follow-up edit this guarantees the commit chains on the real head rather
   * than on a value the throttled refetch has not delivered yet. */
  const waitForRowToMatchHead = async (who: User) => {
    await expect.poll(async () => {
      const head = await readHead(aliceJwt, seeded, cellId)
      const ui = await users[who].ws.readTargetText(CELL_INDEX)
      return head && ui === head.value ? "in sync" : `ui=${JSON.stringify(ui)} head=${JSON.stringify(head?.value)}`
    }, { timeout: 30_000, message: `${who}'s row should catch up with the server head (throttled refetch)` }).toBe("in sync")
  }

  /** Open the cell, replace its text, blur. Blur commits immediately, so the
   * POST leaves the browser now and spends >1 s in flight under throttle. */
  const commitAs = async (who: User, value: string) => {
    const { page, ws } = users[who]
    await expect.poll(
      () => ws.isTargetLockedByOther(CELL_INDEX),
      { message: `${who} should be able to take the cell (other user's lease released)` },
    ).toBe(false)
    await ws.activateTargetCell(CELL_INDEX)
    await ws.replaceActiveTargetText(CELL_INDEX, value)
    const sent = waitForCommitSent(page, cellId, value)
    await ws.blurEditor()
    await sent
  }

  // AQU-1220: latency cannot guarantee a race. Hold both real first-commit
  // requests before either reaches the server, then verify their parents.
  // This still exercises the client producer and the server compare-and-swap;
  // no event payload or response is synthesized by the test.
  const racingRequests: Request[] = []
  const racingContinuations: Promise<void>[] = []
  let releaseRace!: () => void
  const raceReady = new Promise<void>((resolve) => { releaseRace = resolve })
  const holdFirstCommit = async (route: Route) => {
    const values = commitValuesIn(route.request(), cellId)
    if (values.includes(ALICE_VALUES[0]) || values.includes(BOB_VALUES[0])) {
      racingRequests.push(route.request())
      const continued = raceReady.then(() => route.continue())
      racingContinuations.push(continued)
      await continued
      return
    }
    await route.continue()
  }
  await alice.route("**/events", holdFirstCommit)
  await bob.route("**/events", holdFirstCommit)
  try {
    // 1. Alice takes the cell. Bob must observe the advisory focus lock.
    await aliceWs.activateTargetCell(CELL_INDEX)
    await expect.poll(
      () => bobWs.isTargetLockedByOther(CELL_INDEX),
      { message: "bob's row should be read-only while alice holds the focus lock" },
    ).toBe(true)
    await aliceWs.replaceActiveTargetText(CELL_INDEX, ALICE_VALUES[0])
    const aliceFirstSent = waitForCommitSent(alice, cellId, ALICE_VALUES[0])
    await aliceWs.blurEditor()
    await aliceFirstSent

    // 2. Alice's request is held while Bob produces his own first commit.
    // The unthrottled socket releases her lock independently of that request.
    await commitAs("bob", BOB_VALUES[0])
    await expect.poll(() => racingRequests.length, {
      message: "both first commits must reach the barrier before either applies",
      timeout: 30_000,
    }).toBe(2)
    const parents = racingRequests.map((request) => {
      const body = request.postDataJSON() as { events: CommitEvent[] }
      return body.events.find(
        (event) => event.kind === "target.cell.commit" && event.cellId === cellId,
      )?.parentId
    })
    expect(parents[0], "Alice's serialized commit has an explicit parent")
      .toBeDefined()
    expect(parents[1], "the racing commits must share the same parent")
      .toBe(parents[0])
  } finally {
    releaseRace()
    await Promise.all(racingContinuations)
    await alice.unroute("**/events", holdFirstCommit)
    await bob.unroute("**/events", holdFirstCommit)
  }

  // 3. Two more rounds each, interleaved. Each user first catches up with the
  //    server head so the follow-ups chain correctly, then commits through the
  //    throttled link while the other user's refetch is still in flight.
  for (let round = 1; round < ALICE_VALUES.length; round++) {
    await waitForRowToMatchHead("alice")
    await commitAs("alice", ALICE_VALUES[round])
    await waitForRowToMatchHead("bob")
    await commitAs("bob", BOB_VALUES[round])
  }

  // 5. Back to a fast network; everything queued must drain and settle.
  await aliceNet.release()
  await bobNet.release()

  // a. Convergence: alice UI == bob UI == server projection.
  let convergedHead: { value: string; eventId: string } | null = null
  await expect.poll(async () => {
    const head = await readHead(aliceJwt, seeded, cellId)
    const [a, b] = await Promise.all([
      aliceWs.readTargetText(CELL_INDEX),
      bobWs.readTargetText(CELL_INDEX),
    ])
    if (head && a === head.value && b === head.value) {
      convergedHead = head
      return "converged"
    }
    return `alice=${JSON.stringify(a)} bob=${JSON.stringify(b)} server=${JSON.stringify(head?.value)}`
  }, { timeout: 30_000, message: "both browsers and the projection should agree on one value (outbox drain + DO fan-out after throttle release)" }).toBe("converged")
  const head0 = convergedHead as { value: string; eventId: string } | null
  expect(head0, "converged head").not.toBeNull()

  // b. No data loss: every value either browser actually posted is in the
  //    cell's event log — and both scripted value sets were in fact posted.
  expect(aliceSent, "alice's posted commit values").toEqual(expect.arrayContaining([...ALICE_VALUES]))
  expect(bobSent, "bob's posted commit values").toEqual(expect.arrayContaining([...BOB_VALUES]))
  const history = await readCellHistory(aliceJwt, seeded, cellId)
  const logged = new Set(
    history
      .filter((e) => e.kind === "target.cell.commit")
      .map((e) => (e.payload as { value?: string }).value),
  )
  const missing = [...new Set([...aliceSent, ...bobSent])].filter((v) => !logged.has(v))
  expect(missing, `committed values absent from the server event log (logged: ${[...logged].join(" | ")})`).toEqual([])

  // c. No ping-pong: the head must not move once both users have stopped.
  const observed: string[] = []
  const stableUntil = Date.now() + 3_000
  while (Date.now() < stableUntil) {
    const head = await readHead(aliceJwt, seeded, cellId)
    observed.push(`${head?.eventId}:${head?.value}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  expect(
    new Set(observed),
    `head flipped after quiescence: ${observed.join(" → ")}`,
  ).toEqual(new Set([`${head0!.eventId}:${head0!.value}`]))

  // d. The racing pair (first values) shared a parent, so exactly one is
  //    off-chain. Its author sees it flagged in the history drawer and can
  //    promote it; the promotion becomes the new head everywhere.
  const byId = new Map(history.map((e) => [e.id, e]))
  const onChain = new Set<string>()
  for (let cursor: string | null = head0!.eventId; cursor && !onChain.has(cursor); ) {
    onChain.add(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
  const racing = history.filter(
    (e) => e.kind === "target.cell.commit"
      && [ALICE_VALUES[0], BOB_VALUES[0]].includes((e.payload as { value?: string }).value as never),
  )
  expect(racing.map((e) => (e.payload as { value: string }).value).sort(), "both racing values logged").toEqual(
    [ALICE_VALUES[0], BOB_VALUES[0]].sort(),
  )
  const bumped = racing.filter((e) => !onChain.has(e.id))
  expect(bumped, "exactly one of the racing pair lost the compare-and-swap").toHaveLength(1)
  const bumpedValue = (bumped[0].payload as { value: string }).value
  const bumpedAuthor = bumped[0].author as "alice" | "bob"
  expect(["alice", "bob"], "bumped commit is attributed to one of the two editors").toContain(bumpedAuthor)
  const bumpedUser = users[bumpedAuthor]

  await bumpedUser.ws.openHistoryDrawer(CELL_INDEX)
  await expect(bumpedUser.ws.bumpedHistoryEntry(bumpedValue)).toHaveCount(1)
  await bumpedUser.ws.promoteBumpedHistoryEntry(bumpedValue)

  await expect.poll(async () => {
    const head = await readHead(aliceJwt, seeded, cellId)
    const [a, b] = await Promise.all([
      aliceWs.readTargetText(CELL_INDEX),
      bobWs.readTargetText(CELL_INDEX),
    ])
    return `server=${head?.value} alice=${a} bob=${b}`
  }, { message: "promoting the bumped edit should make it the head in both browsers" })
    .toBe(`server=${bumpedValue} alice=${bumpedValue} bob=${bumpedValue}`)
})
