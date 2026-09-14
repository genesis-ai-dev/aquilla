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
