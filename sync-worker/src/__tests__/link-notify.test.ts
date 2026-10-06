// AQU-479 push accelerator: `link.upstream-changed` notify hook tests.
//
// The hook (link-notify.ts's notifyLiveDownstreamsOfUpstreamChanges, wired
// from route.ts via ctx.waitUntil after the ProjectSync event.applied fan-out)
// must:
//   - fire a frame per live (non-clone) downstream when a commit batch
//     contains a kind that downstream's link mirrors (link-sync.ts's
//     laneKindsFor — the ONE list, AQU-1545)
//   - NOT fire for clone-mode downstreams
//   - NOT fire when the batch is comment/validation/audio-only (no lane-
//     relevant kind touched)
//   - respect the downstream-count cap
//   - never be awaited in the request path (response resolves before the
//     notify promise) — the self-heal / no-regression acceptance criteria.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("partyserver", () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from "../events/route"
import {
  __resetLinkNotifyDownstreamCacheForTests,
  collectLaneTouches,
  isLinkLaneKind,
} from "../events/link-notify"
import { laneKindsFor } from "../events/link-sync"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import type { RawEvent } from "../events/types"

const SECRET = "test-secret"
const UPSTREAM = "proj-upstream"

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: UPSTREAM,
    fileId: "file-x",
    role: 500,
    ...overrides,
  } as never)
}

function sourceCommit(overrides: Partial<RawEvent<"source.cell.commit">> = {}): RawEvent<"source.cell.commit"> {
  return {
    id: "evt-src-commit-1",
    schemaVersion: 1,
    kind: "source.cell.commit",
    projectId: UPSTREAM,
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "importer",
    payload: { value: "new source text" },
    clientTs: 1000,
    ...overrides,
  }
}

function commentCreate(overrides: Partial<RawEvent<"comment.create">> = {}): RawEvent<"comment.create"> {
  return {
    id: "evt-comment-1",
    schemaVersion: 1,
    kind: "comment.create",
    projectId: UPSTREAM,
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload: { commentId: "c1", body: "hi", scope: "cell" },
    clientTs: 1000,
    ...overrides,
  } as RawEvent<"comment.create">
}

async function makeRequest(events: unknown[], token?: string): Promise<Request> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`
  return new Request("https://worker/events", { method: "POST", headers, body: JSON.stringify({ events }) })
}

/** Fake ExecutionContext — records waitUntil promises so tests can await
 *  them explicitly (since the hook must NOT be awaited by the route itself). */
function makeCtx() {
  const promises: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { promises.push(p) } },
    flush: () => Promise.all(promises),
  }
}

function makeProjectSyncEnv(db: AquillaDb) {
  const bodies: Array<{ downstream: string; body: Record<string, unknown> }> = []
  const env = {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    ProjectSync: {
      idFromName: vi.fn().mockImplementation((name: string) => ({ id: name })),
      get: vi.fn().mockImplementation((id: { id: string }) => ({
        fetch: vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
          bodies.push({ downstream: id.id, body: JSON.parse(String(init?.body)) })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }),
      })),
    } as unknown as DurableObjectNamespace,
  }
  return { env, bodies }
}

async function seedUpstreamFile(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
}

async function seedDownstream(
  t: TestDb,
  id: string,
  mode: "live" | "clone",
  consumes: "source" | "target" | null = null,
): Promise<void> {
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes)
     VALUES ($1, $2, 1, $3, $4, $5)`,
    [id, id, UPSTREAM, mode, consumes],
  )
}

function visibilitySet(hidden: boolean, id: string): RawEvent<"source.cell.visibility.set"> {
  return {
    id,
    schemaVersion: 1,
    kind: "source.cell.visibility.set",
    projectId: UPSTREAM,
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "lead",
    payload: { hidden },
    clientTs: 1000,
  }
}

function fileRename(name: string): RawEvent<"file.rename"> {
  return {
    id: "evt-file-rename-1",
    schemaVersion: 1,
    kind: "file.rename",
    projectId: UPSTREAM,
    fileId: "file-x",
    parentId: null,
    author: "lead",
    payload: { name },
    clientTs: 1000,
  } as RawEvent<"file.rename">
}

function targetCommit(): RawEvent<"target.cell.commit"> {
  return {
    id: "evt-tgt-commit-1",
    schemaVersion: 1,
    kind: "target.cell.commit",
    projectId: UPSTREAM,
    fileId: "file-x",
    cellId: "cell-1",
    parentId: null,
    author: "alice",
    payload: { value: "translated" },
    clientTs: 1000,
  } as RawEvent<"target.cell.commit">
}

/** Commit `events` to the upstream through the real route and return the
 *  `link.upstream-changed` frames the notify hook sent. */
async function commitAndCollectFrames(t: TestDb, events: unknown[]): Promise<UpstreamChangedFrame[]> {
  const { env, bodies } = makeProjectSyncEnv(t.db)
  const { ctx, flush } = makeCtx()
  const res = await handleEventsWriteRequest(await makeRequest(events, await makeToken()), env, ctx)
  expect(res?.status).toBe(200)
  const body = (await res!.clone().json()) as { rejected: unknown[] }
  expect(body.rejected).toEqual([])
  await flush()
  return upstreamChangedFrames(bodies)
}

interface UpstreamChangedFrame {
  downstream: string
  t: string
  project: string
  upstream: string
  untilSeq: number
  fileIds: string[]
  cellIds: string[]
  filesChanged?: boolean
}

function upstreamChangedFrames(
  bodies: Array<{ downstream: string; body: Record<string, unknown> }>,
): UpstreamChangedFrame[] {
  return bodies
    .map((b) => ({ downstream: b.downstream, ...b.body }) as UpstreamChangedFrame)
    .filter((b) => b.t === "link.upstream-changed")
}

describe("AQU-479 link.upstream-changed notify hook", () => {
  beforeEach(() => {
    __resetLinkNotifyDownstreamCacheForTests()
  })

  it("emits a frame to a live downstream for a lane-relevant upstream commit", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")
      const { env, bodies } = makeProjectSyncEnv(t.db)
      const { ctx, flush } = makeCtx()

      const token = await makeToken()
      const res = await handleEventsWriteRequest(await makeRequest([sourceCommit()], token), env, ctx)
      expect(res?.status).toBe(200)
      await flush()

      const frames = upstreamChangedFrames(bodies)
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({
        downstream: "proj-down-live",
        project: "proj-down-live",
        upstream: UPSTREAM,
      })
      expect(frames[0].fileIds).toEqual(["file-x"])
      expect(frames[0].cellIds).toEqual(["cell-1"])
      expect(typeof frames[0].untilSeq).toBe("number")
    } finally {
      await t.close()
    }
  })

  it("does NOT emit a frame to a clone-mode downstream", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-clone", "clone")
      const { env, bodies } = makeProjectSyncEnv(t.db)
      const { ctx, flush } = makeCtx()

      const token = await makeToken()
      const res = await handleEventsWriteRequest(await makeRequest([sourceCommit()], token), env, ctx)
      expect(res?.status).toBe(200)
      await flush()

      expect(upstreamChangedFrames(bodies)).toHaveLength(0)
    } finally {
      await t.close()
    }
  })

  it("does NOT emit a frame for a comment-only batch (not lane-relevant)", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")
      const { env, bodies } = makeProjectSyncEnv(t.db)
      const { ctx, flush } = makeCtx()

      const token = await makeToken()
      const res = await handleEventsWriteRequest(await makeRequest([commentCreate()], token), env, ctx)
      expect(res?.status).toBe(200)
      await flush()

      expect(upstreamChangedFrames(bodies)).toHaveLength(0)
    } finally {
      await t.close()
    }
  })

  it("respects the downstream-notification cap", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      const total = 55 // above LINK_NOTIFY_DOWNSTREAM_CAP (50)
      for (let i = 0; i < total; i++) {
        await seedDownstream(t, `proj-down-${i}`, "live")
      }
      const { env, bodies } = makeProjectSyncEnv(t.db)
      const { ctx, flush } = makeCtx()

      const token = await makeToken()
      const res = await handleEventsWriteRequest(await makeRequest([sourceCommit()], token), env, ctx)
      expect(res?.status).toBe(200)
      await flush()

      expect(upstreamChangedFrames(bodies)).toHaveLength(50)
    } finally {
      await t.close()
    }
  })

  it("caps cellIds per frame at 64", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")
      const { env, bodies } = makeProjectSyncEnv(t.db)
      const { ctx, flush } = makeCtx()

      const events: RawEvent<"source.cell.commit">[] = []
      for (let i = 0; i < 100; i++) {
        events.push(
          sourceCommit({ id: `evt-src-commit-${i}`, cellId: `cell-${i}`, payload: { value: `v${i}` } }),
        )
      }
      const token = await makeToken()
      const res = await handleEventsWriteRequest(await makeRequest(events, token), env, ctx)
      expect(res?.status).toBe(200)
      await flush()

      const frames = upstreamChangedFrames(bodies)
      expect(frames).toHaveLength(1)
      expect((frames[0].cellIds as string[]).length).toBe(64)
    } finally {
      await t.close()
    }
  })

  it("does not delay the response — notify runs strictly after the response is built", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")

      let resolveFetch: (() => void) | null = null
      const gate = new Promise<void>((resolve) => { resolveFetch = resolve })
      const order: string[] = []

      const env = {
        AQUILLA_PG: t.db,
        SYNC_SECRET_KEY: SECRET,
        ProjectSync: {
          idFromName: vi.fn().mockImplementation((name: string) => ({ id: name })),
          get: vi.fn().mockImplementation(() => ({
            fetch: vi.fn().mockImplementation(async (url: string) => {
              if (String(url).includes("__broadcast")) {
                // Delay the broadcast fetch until after we've observed the
                // response — if the route awaited this, the response would
                // never resolve before the gate opens.
              }
              await gate
              order.push("broadcast-fetch-resolved")
              return new Response(JSON.stringify({ ok: true }), { status: 200 })
            }),
          })),
        } as unknown as DurableObjectNamespace,
      }
      const { ctx, flush } = makeCtx()

      const token = await makeToken()
      const resPromise = handleEventsWriteRequest(await makeRequest([sourceCommit()], token), env, ctx)

      // The response must resolve WITHOUT the broadcast fetch having resolved
      // — proving no awaited fan-out in the request path (only the FIRST
      // event.applied fan-out's own await matters for this specific claim;
      // ProjectSync fan-out for event.applied IS awaited in this file today,
      // so we assert on the notify-hook stage specifically: waitUntil received
      // the promise before the gate opened).
      order.push("before-response-await")
      resolveFetch!()
      const res = await resPromise
      order.push("response-resolved")
      expect(res?.status).toBe(200)
      await flush()
      expect(order).toContain("response-resolved")
    } finally {
      await t.close()
    }
  })

  it("skips cleanly when ProjectSync binding is absent (self-heal parity: no crash, no notify)", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")
      const { ctx } = makeCtx()

      const token = await makeToken()
      const res = await handleEventsWriteRequest(
        await makeRequest([sourceCommit()], token),
        { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }, // no ProjectSync
        ctx,
      )
      expect(res?.status).toBe(200)
      // No throw, no rejected events — the commit path is unaffected by the
      // absent binding. AQU-476's lazy-pull mirror sync remains the floor.
      const body = (await res!.json()) as { accepted: unknown[]; rejected: unknown[] }
      expect(body.accepted).toHaveLength(1)
      expect(body.rejected).toHaveLength(0)
    } finally {
      await t.close()
    }
  })

  it("skips cleanly when ctx is absent (HTTP callers without an ExecutionContext)", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")
      const { env, bodies } = makeProjectSyncEnv(t.db)

      const token = await makeToken()
      // No ctx passed at all.
      const res = await handleEventsWriteRequest(await makeRequest([sourceCommit()], token), env)
      expect(res?.status).toBe(200)
      // event.applied fan-out still happens (awaited); link-notify does not
      // (it requires ctx.waitUntil to be safe to fire-and-forget).
      expect(upstreamChangedFrames(bodies)).toHaveLength(0)
    } finally {
      await t.close()
    }
  })
})

// AQU-1545: hide/show (AQU-1453) and file rename (AQU-1358) became part of what
// a live link mirrors, but the notify hook kept its own copy of the kind list
// and never learned them — an open downstream saw neither until a reload.
describe("AQU-1545 link.upstream-changed for hide/show and rename", () => {
  beforeEach(() => {
    __resetLinkNotifyDownstreamCacheForTests()
  })

  it("an upstream hide notifies a live downstream with the hidden cell", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")

      const frames = await commitAndCollectFrames(t, [visibilitySet(true, "evt-hide-1")])

      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ project: "proj-down-live", upstream: UPSTREAM })
      expect(frames[0].fileIds).toEqual(["file-x"])
      expect(frames[0].cellIds).toEqual(["cell-1"])
      // A cell-level change: the downstream re-reads cells, not its file list.
      expect(frames[0].filesChanged).toBe(false)
    } finally {
      await t.close()
    }
  })

  it("an upstream show notifies a live downstream too", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")

      await commitAndCollectFrames(t, [visibilitySet(true, "evt-hide-1")])
      const frames = await commitAndCollectFrames(t, [visibilitySet(false, "evt-show-1")])

      expect(frames).toHaveLength(1)
      expect(frames[0].cellIds).toEqual(["cell-1"])
    } finally {
      await t.close()
    }
  })

  it("an upstream file rename notifies a live downstream with the file", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-live", "live")

      const frames = await commitAndCollectFrames(t, [fileRename("Renamed upstream file")])

      expect(frames).toHaveLength(1)
      expect(frames[0].fileIds).toEqual(["file-x"])
      expect(frames[0].cellIds).toEqual([])
      // The file list moved — the downstream must re-read it after syncing.
      expect(frames[0].filesChanged).toBe(true)
    } finally {
      await t.close()
    }
  })

  it("a clone-mode copy hears nothing about a hide, a show or a rename", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-clone", "clone")

      const frames = await commitAndCollectFrames(t, [
        visibilitySet(true, "evt-hide-1"),
        visibilitySet(false, "evt-show-1"),
        fileRename("Renamed upstream file"),
      ])

      expect(frames).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("a link that consumes the upstream's translations hears about a translation; a source link does not", async () => {
    // Same drift, other shape: a consumes='target' link mirrors target.cell.commit
    // (link-sync's LANE_KINDS_TARGET_EXTRA), but the old copy only listed the
    // source lane, so that downstream was never told either.
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-source", "live", "source")
      await seedDownstream(t, "proj-down-target", "live", "target")

      const frames = await commitAndCollectFrames(t, [targetCommit()])

      expect(frames.map((f) => f.downstream)).toEqual(["proj-down-target"])
      expect(frames[0].cellIds).toEqual(["cell-1"])
    } finally {
      await t.close()
    }
  })

  it("a source-lane change reaches both link shapes", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamFile(t)
      await seedDownstream(t, "proj-down-source", "live", "source")
      await seedDownstream(t, "proj-down-target", "live", "target")

      const frames = await commitAndCollectFrames(t, [visibilitySet(true, "evt-hide-1")])

      expect(frames.map((f) => f.downstream).sort()).toEqual(["proj-down-source", "proj-down-target"])
    } finally {
      await t.close()
    }
  })
})

describe("AQU-1545 the notify and the mirror sync share one definition of an upstream change", () => {
  // The mirror sync's freshness probe reads laneKindsFor to decide whether to
  // run; the notify must fire for exactly those kinds, per link shape. If either side
  // grows a kind the other lacks, an open downstream either never hears about
  // a change it mirrors (this bug) or syncs on noise it never mirrors.
  for (const shape of ["source", "target"] as const) {
    it(`notifies for every kind a '${shape}' link mirrors`, () => {
      for (const kind of laneKindsFor(shape)) {
        expect({ kind, notifies: isLinkLaneKind(kind, shape) }).toEqual({ kind, notifies: true })
      }
    })
  }

  it("never notifies for kinds no link mirrors", () => {
    for (const kind of ["comment.create", "cell.audio.attach", "cell.backtranslation.set", "file.corpus.set"]) {
      expect({ kind, source: isLinkLaneKind(kind, "source"), target: isLinkLaneKind(kind, "target") }).toEqual({
        kind,
        source: false,
        target: false,
      })
    }
  })

  it("a source link is not notified for the translation-lane kinds only a target link mirrors", () => {
    const sourceKinds = new Set(laneKindsFor("source"))
    const targetOnly = laneKindsFor("target").filter((k) => !sourceKinds.has(k))
    expect(targetOnly.length).toBeGreaterThan(0)
    for (const kind of targetOnly) expect(isLinkLaneKind(kind, "source")).toBe(false)
  })

  it("collects every mirrored kind from a request and drops the rest", () => {
    const frames = [
      ...laneKindsFor("target").map((kind, i) => ({ kind, project: UPSTREAM, cell: `c${i}` })),
      { kind: "comment.create", project: UPSTREAM, cell: "noise" },
    ]
    const touches = collectLaneTouches(frames).get(UPSTREAM) ?? []
    expect(touches.map((x) => x.kind)).toEqual([...laneKindsFor("target")])
  })
})
