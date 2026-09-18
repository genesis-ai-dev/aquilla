import type { Page, Request } from "@playwright/test"
import { test, expect } from "../../helpers/multi-user"
import { waitForProjectSyncReady } from "../../helpers/project-sync"
import {
  jwtFor,
  seedProjectWithFile,
  openSeededProject,
  readCellHistory,
} from "../../helpers/seed-project"
import { Workspace } from "../../helpers/page-objects/Workspace"
import {
  MockLLMServer,
  applyUserProviderOverride,
} from "../../helpers/mock-llm-server"

/**
 * A single editor's successive commits must form a straight chain: each
 * target.cell.commit's parentId is the id of that editor's previous commit on
 * the cell. Under head compare-and-swap (AQU-1154) a commit chained on an
 * older head is refused and lands as a bumped sibling, so a client that
 * forgets its own last commit turns ordinary typing into "bumped by a
 * concurrent edit" — the 2026-09-04 dev report on cell 3.
 *
 * Crosses SPA (editor parent resolution + refetch) + sync-worker (events
 * route, cells read) + Postgres (event log). Two shapes of the same journey:
 * commits within one focus session, and commits separated by a reload (the
 * IndexedDB snapshot + `?since=` delta path).
 */

const CELL_INDEX = 0

const mockLLM = new MockLLMServer()
test.beforeAll(async () => { await mockLLM.start() })
test.afterAll(async () => { await mockLLM.stop() })

async function pendingCellEvents(page: Page, cellId: string) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("aquilla-cqrs-outbox")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Array<{
        id: string
        kind: string
        parentId: string | null
        payload: { value?: string; editEventId?: string }
        outboxLastError?: { reason: string } | null
      }>>((resolve, reject) => {
        const request = db.transaction("outbox").objectStore("outbox").getAll()
        request.onsuccess = () => resolve(request.result
          .map((record) => ({
            ...record.event,
            outboxLastError: record.lastError,
          }))
          .filter((event) => event.cellId === id))
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }, cellId)
}

test("three pending corrections on an already translated verse preserve every parent", async ({ alice }, testInfo) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Existing head ${Date.now()}` })
  const cellId = seeded.cellIds[CELL_INDEX]
  const sync = waitForProjectSyncReady(alice, seeded.projectId)
  const ws = await openSeededProject(alice, seeded)
  await sync
  await ws.editCell(CELL_INDEX, "BASE-H")
  await expect.poll(() => pendingCellEvents(alice, cellId)).toEqual([])
  const resync = waitForProjectSyncReady(alice, seeded.projectId)
  await alice.reload()
  await resync
  await ws.waitForEditor(cellId)
  await expect.poll(() => ws.readTargetText(CELL_INDEX)).toBe("BASE-H")

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await alice.route(/\/events$/, async (route) => {
    if (commitEventsIn(route.request(), cellId).length > 0) await gate
    await route.continue()
  })
  try {
    for (const value of ["EDIT-A", "EDIT-B", "EDIT-C"]) {
      await ws.activateTargetCell(CELL_INDEX)
      await ws.replaceActiveTargetText(CELL_INDEX, value)
      await ws.blurEditor()
      await expect.poll(async () => (await pendingCellEvents(alice, cellId))
        .some((e) => e.payload.value === value)).toBe(true)
    }
    const queued = (await pendingCellEvents(alice, cellId))
      .filter((e) => e.kind === "target.cell.commit")
    await testInfo.attach("existing-head-pending-chain", {
      body: JSON.stringify(queued, null, 2), contentType: "application/json",
    })
    for (let i = 1; i < queued.length; i++) {
      expect.soft(queued[i].parentId, queued[i].payload.value).toBe(queued[i - 1].id)
    }
    release()
    await expectLinearChain(jwt, seeded, cellId, ["BASE-H", "EDIT-A", "EDIT-B", "EDIT-C"])
    await expect.poll(() => pendingCellEvents(alice, cellId)).toEqual([])
    const reloaded = waitForProjectSyncReady(alice, seeded.projectId)
    await alice.reload()
    await reloaded
    await ws.waitForEditor(cellId)
    await expect.poll(() => ws.readTargetText(CELL_INDEX)).toBe("EDIT-C")
  } finally {
    release()
    await alice.unrouteAll({ behavior: "wait" })
  }
})

const valueOf = (payload: unknown): string | undefined =>
  (payload as { value?: string } | null)?.value

function commitEventsIn(request: Request, cellId: string): Array<{ id: string; parentId: string | null; value: string }> {
  if (request.method() !== "POST") return []
  try {
    if (!new URL(request.url()).pathname.endsWith("/events")) return []
  } catch {
    return []
  }
  const body = request.postDataJSON() as {
    events?: Array<{ id: string; kind: string; cellId?: string; parentId?: string | null; payload?: { value?: string } }>
  } | null
  return (body?.events ?? [])
    .filter((e) => e.kind === "target.cell.commit" && e.cellId === cellId)
    .map((e) => ({ id: e.id, parentId: e.parentId ?? null, value: e.payload?.value ?? "" }))
}

function waitForCommitSent(page: Page, cellId: string, value: string): Promise<Request> {
  return page.waitForRequest(
    (request) => commitEventsIn(request, cellId).some((e) => e.value === value),
    { timeout: 10_000 },
  )
}

async function expectLinearChain(jwt: string, seeded: Awaited<ReturnType<typeof seedProjectWithFile>>, cellId: string, values: readonly string[]) {
  await expect.poll(async () => {
    const history = await readCellHistory(jwt, seeded, cellId)
    const commits = history
      .filter((e) => e.kind === "target.cell.commit")
      .sort((a, b) => Number(a.serverSeq) - Number(b.serverSeq))
    return commits.map((c) => valueOf(c.payload))
  }, { timeout: 10_000, message: "every commit should reach the event log" }).toEqual([...values])

  const history = await readCellHistory(jwt, seeded, cellId)
  const commits = history
    .filter((e) => e.kind === "target.cell.commit")
    .sort((a, b) => Number(a.serverSeq) - Number(b.serverSeq))
  for (let i = 1; i < commits.length; i++) {
    expect(
      commits[i].parentId,
      `commit "${valueOf(commits[i].payload)}" must chain on the previous commit "${valueOf(commits[i - 1].payload)}", not on an older head`,
    ).toBe(commits[i - 1].id)
  }
}

test("successive commits in one focus session chain on each other", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Chain ${Date.now()}` })
  const cellId = seeded.cellIds[CELL_INDEX]

  const sync = waitForProjectSyncReady(alice, seeded.projectId)
  const ws = await openSeededProject(alice, seeded)
  await sync

  await ws.activateTargetCell(CELL_INDEX)
  const first = waitForCommitSent(alice, cellId, "first draft")
  await ws.replaceActiveTargetText(CELL_INDEX, "first draft")
  await first // idle-debounce commit left the browser; editor still focused

  // Wait for the projection to catch up before the next edit — this is the
  // window in which the client must have learned its own commit is the head.
  await expect.poll(async () => {
    const history = await readCellHistory(jwt, seeded, cellId)
    return history.some((e) => e.kind === "target.cell.commit" && valueOf(e.payload) === "first draft")
  }).toBe(true)

  const second = waitForCommitSent(alice, cellId, "first draft, then revised")
  await ws.replaceActiveTargetText(CELL_INDEX, "first draft, then revised")
  await second

  const third = waitForCommitSent(alice, cellId, "final wording after blur")
  await ws.replaceActiveTargetText(CELL_INDEX, "final wording after blur")
  await ws.blurEditor()
  await third

  await expectLinearChain(jwt, seeded, cellId, ["first draft", "first draft, then revised", "final wording after blur"])
})

test("a commit after a reload chains on the commit made before it", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Chain reload ${Date.now()}` })
  const cellId = seeded.cellIds[CELL_INDEX]

  const sync = waitForProjectSyncReady(alice, seeded.projectId)
  let ws = await openSeededProject(alice, seeded)
  await sync

  await ws.activateTargetCell(CELL_INDEX)
  const first = waitForCommitSent(alice, cellId, "before reload")
  await ws.replaceActiveTargetText(CELL_INDEX, "before reload")
  await ws.blurEditor()
  await first
  await expect.poll(async () => {
    const history = await readCellHistory(jwt, seeded, cellId)
    return history.some((e) => e.kind === "target.cell.commit" && valueOf(e.payload) === "before reload")
  }).toBe(true)

  // A real reload: the warm IndexedDB snapshot paints first and the client
  // pulls a `?since=` delta instead of the full source stream, so the
  // openSeededProject helper (which waits on that stream) does not apply.
  const resync = waitForProjectSyncReady(alice, seeded.projectId)
  await alice.reload()
  await resync
  ws = new Workspace(alice)
  await ws.waitForEditor(cellId)
  await expect.poll(() => ws.readTargetText(CELL_INDEX)).toBe("before reload")

  await ws.activateTargetCell(CELL_INDEX)
  const second = waitForCommitSent(alice, cellId, "after reload")
  await ws.replaceActiveTargetText(CELL_INDEX, "after reload")
  await ws.blurEditor()
  await second

  await expectLinearChain(jwt, seeded, cellId, ["before reload", "after reload"])
})

test("a second tab of the same user sees the first tab's commit and chains on it", async ({ alice }) => {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `Chain two tabs ${Date.now()}` })
  const cellId = seeded.cellIds[CELL_INDEX]

  // Tab 1 and tab 2 share the origin: same session, same IndexedDB outbox,
  // same username on every `event.applied` frame. Own-write echoes must not
  // leave the tab that did NOT post the commit on a stale head.
  const sync1 = waitForProjectSyncReady(alice, seeded.projectId)
  const ws1 = await openSeededProject(alice, seeded)
  await sync1
  const tab2 = await alice.context().newPage()
  const sync2 = waitForProjectSyncReady(tab2, seeded.projectId)
  // Shared IndexedDB snapshot → tab 2 paints from cache and pulls a delta,
  // not the full source stream openSeededProject waits on.
  await tab2.goto(`/project/${seeded.projectId}/editor/file/${seeded.fileId}`)
  await sync2
  const ws2 = new Workspace(tab2)
  await ws2.waitForEditor(cellId)

  await ws1.activateTargetCell(CELL_INDEX)
  const first = waitForCommitSent(alice, cellId, "from tab one")
  await ws1.replaceActiveTargetText(CELL_INDEX, "from tab one")
  await ws1.blurEditor()
  await first

  await expect.poll(() => ws2.readTargetText(CELL_INDEX), {
    timeout: 10_000,
    message: "tab 2 (same user) should show tab 1's committed text",
  }).toBe("from tab one")

  await ws2.activateTargetCell(CELL_INDEX)
  const second = waitForCommitSent(tab2, cellId, "from tab two")
  await ws2.replaceActiveTargetText(CELL_INDEX, "from tab two")
  await ws2.blurEditor()
  await second

  await expectLinearChain(jwt, seeded, cellId, ["from tab one", "from tab two"])
  await tab2.close()
})

// AQU-1309: force the reported ordering without depending on network speed.
// Both saves cross the real SPA/outbox/worker/Postgres boundary. Only their
// delivery is gated; the AI provider supplies deterministic draft text.
for (const { draftOrigin, loseAck, bufferAtAck } of [
  { draftOrigin: "human", loseAck: false, bufferAtAck: false },
  { draftOrigin: "AI", loseAck: false, bufferAtAck: false },
  { draftOrigin: "AI", loseAck: true, bufferAtAck: false },
  { draftOrigin: "AI", loseAck: false, bufferAtAck: true },
]) {
  const delivery = bufferAtAck ? "correction only in editor buffer"
    : loseAck ? "lost acknowledgement and retry" : "delayed delivery"
  test(`${draftOrigin} draft pending (${delivery}): correction chains locally and survives the older save`, async ({ alice }, testInfo) => {
    const jwt = await jwtFor("alice")
    const seeded = await seedProjectWithFile(jwt, {
      name: `Pending ${draftOrigin} ${Date.now()}`,
    })
    if (bufferAtAck) await alice.clock.install()
    const cellId = seeded.cellIds[CELL_INDEX]
    const sync = waitForProjectSyncReady(alice, seeded.projectId)
    const ws = await openSeededProject(alice, seeded)
    await sync
    if (draftOrigin === "AI") {
      await applyUserProviderOverride(alice, "alice", `${mockLLM.baseUrl}/v1`)
      const resync = waitForProjectSyncReady(alice, seeded.projectId)
      await alice.reload()
      await resync
      await ws.waitForEditor(cellId)
      mockLLM.setNextResponse("DRAFT-A")
    }

    let releaseDraft!: () => void
    let releaseCorrection!: () => void
    const draftGate = new Promise<void>((r) => { releaseDraft = r })
    const correctionGate = new Promise<void>((r) => { releaseCorrection = r })
    let draftRequest: ReturnType<typeof commitEventsIn>[number] | undefined
    let draftDelivered = false
    let draftAttempts = 0
    let draftAckDropped = false
    let correctionIntercepted = false
    const exchanges: Array<{
      events: unknown
      result: { stale?: Array<{ id: string }> }
    }> = []
    await alice.route(/\/events$/, async (route) => {
      const commits = commitEventsIn(route.request(), cellId)
      const hasDraft = commits.some((e) => e.value === "DRAFT-A")
      const hasCorrection = commits.some((e) => e.value === "HUMAN-B")
      const draftAttempt = hasDraft ? ++draftAttempts : 0
      if (hasDraft) {
        draftRequest = commits.find((e) => e.value === "DRAFT-A")
        // Commit the first lost-ack attempt immediately, then drop its response.
        // Holding it until the native timeout races Playwright's route abort.
        if (!loseAck || draftAttempt !== 1) await draftGate
      }
      if (hasCorrection) {
        correctionIntercepted = true
        await correctionGate
      }
      if (!hasDraft && !hasCorrection) {
        await route.continue()
        return
      }
      const response = await route.fetch()
      exchanges.push({
        events: route.request().postDataJSON(),
        result: await response.json(),
      })
      if (loseAck && draftAttempt === 1) {
        // The real server has committed. Simulate losing its response, the
        // uncertain outcome that also occurs when a 15-second timeout fires.
        await route.abort("timedout")
        draftAckDropped = true
        draftDelivered = true
        return
      }
      await route.fulfill({ response })
      if (hasDraft) draftDelivered = true
    })

    try {
      if (draftOrigin === "AI") {
        await ws.clickSparkleOnFirstCell()
      } else {
        await ws.activateTargetCell(CELL_INDEX)
        await ws.replaceActiveTargetText(CELL_INDEX, "DRAFT-A")
        await ws.blurEditor()
      }
      await expect.poll(() => draftRequest).toBeDefined()
      await expect.poll(() => ws.readTargetText(CELL_INDEX)).toBe("DRAFT-A")

      await ws.activateTargetCell(CELL_INDEX)
      if (bufferAtAck) {
        // Freeze the idle debounce so the correction cannot acquire an
        // IndexedDB overlay before the older save lands. Network/IDB work
        // still runs; no wall-clock delay decides whether the race occurs.
        const now = await alice.evaluate(() => Date.now())
        await alice.clock.pauseAt(now + 100)
      }
      await ws.replaceActiveTargetText(CELL_INDEX, "HUMAN-B")
      if (bufferAtAck) {
        expect((await pendingCellEvents(alice, cellId))
          .some((e) => e.payload.value === "HUMAN-B")).toBe(false)
        releaseDraft()
        await expect.poll(() => draftDelivered, { timeout: 30_000 }).toBe(true)
        // Waiting for the outbox to drain proves the author processed A's
        // acknowledgement, rather than merely receiving a network response.
        await expect.poll(() => pendingCellEvents(alice, cellId)).toEqual([])
        expect(await ws.readTargetText(CELL_INDEX)).toBe("HUMAN-B")
        await alice.clock.resume()
      }
      // Navigation commits the correction and its automatic self-validation.
      await ws.activateTargetCell(1)
      await ws.replaceActiveTargetText(1, "NEXT-VERSE")
      await expect.poll(async () => (await pendingCellEvents(alice, cellId))
        .some((e) => e.payload.value === "HUMAN-B")).toBe(true)
      const queued = await pendingCellEvents(alice, cellId)
      const correction = queued.find((e) => e.payload.value === "HUMAN-B")!
      await expect.poll(async () => (await pendingCellEvents(alice, cellId))
        .some((e) => e.kind === "cell.validate"
          && e.payload.editEventId === correction.id)).toBe(true)
      await testInfo.attach("pending-event-chain", {
        body: JSON.stringify({ draftRequest, queued }, null, 2),
        contentType: "application/json",
      })
      expect.soft(correction.parentId).toBe(draftRequest!.id)

      releaseDraft()
      await expect.poll(() => draftDelivered, { timeout: 30_000 }).toBe(true)
      await expect.poll(() => correctionIntercepted).toBe(true)
      // A is committed (acknowledged or timed out); B remains unacknowledged.
      await expect.poll(() => ws.readTargetText(CELL_INDEX)).toBe("HUMAN-B")
      releaseCorrection()
      await expectLinearChain(jwt, seeded, cellId, ["DRAFT-A", "HUMAN-B"])
      await expect.poll(() => pendingCellEvents(alice, cellId)).toEqual([])
      if (loseAck) {
        expect(draftAckDropped).toBe(true)
        expect(draftAttempts).toBeGreaterThan(1)
      }
      await alice.unrouteAll({ behavior: "wait" })
      const resync = waitForProjectSyncReady(alice, seeded.projectId)
      await alice.reload()
      await resync
      await ws.waitForEditor(cellId)
      await expect.poll(() => ws.readTargetText(CELL_INDEX)).toBe("HUMAN-B")
      await ws.expectSelfValidated(CELL_INDEX)
      const staleIds = exchanges.flatMap(({ result }) =>
        (result.stale ?? []).map((event) => event.id))
      expect(staleIds,
        "retrying the same event ID must not report a competing edit",
      ).not.toContain(draftRequest!.id)
    } finally {
      releaseDraft()
      releaseCorrection()
      await alice.unrouteAll({ behavior: "wait" })
      await testInfo.attach("save-exchanges", {
        body: JSON.stringify(exchanges, null, 2),
        contentType: "application/json",
      })
    }
  })
}
