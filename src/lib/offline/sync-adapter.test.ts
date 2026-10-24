import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { schema, tables, events, cellRowId, DEFAULT_LANE_KEY, localLaneKey } from "./schema"
import { createOfflineSyncAdapter, MAX_FLUSH_BATCH, type MintToken } from "./sync-adapter"
import { __resetConflictsForTests, getConflicts } from "./conflicts"
import { catchUpProject } from "./catch-up"
import { isProjectUnavailable, resetProjectAccessForTests } from "./project-access"

// The catch-up pull reads over real HTTP; these tests are about the socket and
// the flush, so stub it (catch-up.test.ts covers it). The row-mapping helpers
// stay real — applyRows uses them.
vi.mock("./catch-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./catch-up")>()),
  catchUpProject: vi.fn(async () => ({ filesChecked: 0, rowsChanged: 0 })),
}))

// ── Fake WebSocket harness (mirrors src/lib/sync/ws-reconciler.test.ts) ────

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  url: string
  sent: string[] = []
  onopen: ((this: WebSocket) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.call(this as unknown as WebSocket)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent)
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent)
  }
}

const FakeWsCtor = FakeWebSocket as unknown as typeof WebSocket

async function drainMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Lets an adapter built with `frameCoalesceMs: 0` land its buffered live frames. */
async function landFrames(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let store: Store<typeof schema>
let storeId = 0

beforeEach(async () => {
  storeId += 1
  store = await createStorePromise({
    schema,
    storeId: `sync-adapter-test-${storeId}`,
    adapter: makeInMemoryAdapter(),
    disableDevtools: true,
    batchUpdates: (run) => run(),
  })
  FakeWebSocket.instances.length = 0
  __resetConflictsForTests()
  resetProjectAccessForTests()
  vi.mocked(catchUpProject).mockClear()
})

const okMint: MintToken = async () => ({ token: "tok-1", status: null })

describe("createOfflineSyncAdapter", () => {
  it("mints a token scoped to a locally synced file and opens the project WS", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const mintToken = vi.fn(okMint)

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
    })

    await drainMicrotasks()
    expect(mintToken).toHaveBeenCalledWith("proj1", "file1")
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toContain("proj1")
    expect(FakeWebSocket.instances[0].url).toContain("token=tok-1")

    adapter.close()
  })

  it("writes event.applied rows into the cells table", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      frameCoalesceMs: 0,
    })

    await drainMicrotasks()
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.receive({
      t: "event.applied",
      id: "evt-1",
      kind: "target.cell.commit",
      project: "proj1",
      file: "file1",
      rows: [
        {
          cellId: "GEN 1:1",
          side: "target",
          value: "En el principio",
          valueHtml: null,
          eventId: "evt-1",
          sourceEventId: "src-evt-1",
          validated: false,
          aiDrafted: false,
          sequenceIndex: 0,
          canonicalRef: "GEN.1.1",
        },
      ],
    })
    await landFrames()

    const row = store.query(
      tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "target", DEFAULT_LANE_KEY) }).first(),
    )
    expect(row).toMatchObject({ value: "En el principio", eventId: "evt-1" })

    adapter.close()
  })

  it("dequeues and marks a conflict when the server reports a stale sibling over WS", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: "proj1",
        fileId: "file1",
        cellId: "GEN 1:1",
        kind: "target.cell.commit",
        payload: { value: "stale write" },
        parentId: "old-head",
        author: "dev@local.test",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )

    // onOpen also triggers a flush of the newly-queued row; stub fetch so
    // that race doesn't make a real network call before the WS frame below
    // exercises the code path this test actually cares about.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: [], rejected: [], stale: [] }), { status: 200 }))
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await drainMicrotasks()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    // The flush triggered by onOpen would also fire; give it a tick, then
    // simulate the server's stale rejection arriving over the socket.
    await drainMicrotasks()
    ws.receive({ t: "event.stale", id: "q1", reason: "parent mismatch" })

    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toBeUndefined()
    expect(getConflicts().has(cellRowId("proj1", "file1", "GEN 1:1", "target", DEFAULT_LANE_KEY))).toBe(true)

    adapter.close()
  })
})

describe("flushNow", () => {
  it("POSTs pending queue rows and dequeues accepted ones", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: "proj1",
        fileId: "file1",
        cellId: "GEN 1:1",
        kind: "target.cell.commit",
        payload: { value: "hola" },
        parentId: "head-1",
        author: "dev@local.test",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: [{ id: "q1" }], rejected: [], stale: [] }), { status: 200 }),
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await drainMicrotasks()

    await adapter.flushNow()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://sync.example.com/events")
    const body = JSON.parse(init.body as string) as { events: Array<{ id: string; author: string }> }
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ id: "q1", author: "dev@local.test", kind: "target.cell.commit" })

    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toBeUndefined()

    adapter.close()
  })

  it.each([
    [403, "role too low for target.cell.commit"],
    [422, 'unknown lane "fr"; register it in settings.targetLanes'],
    [400, "event missing fileId"],
  ])("keeps a write the server refuses with %i as failed, not dequeued", async (status, reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    queueCommit("q1")

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: [], rejected: [{ id: "q1", status, reason }], stale: [] }), { status: 200 }),
    )
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await drainMicrotasks()

    await adapter.flushNow()

    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toMatchObject({ status: "failed" })
    adapter.close()
  })

  it("marks a conflict and dequeues on a stale flush result", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: "proj1",
        fileId: "file1",
        cellId: "GEN 1:1",
        kind: "target.cell.commit",
        payload: { value: "hola" },
        parentId: "stale-head",
        author: "dev@local.test",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )

    // Per CLAUDE.md's AD-2 head-CAS contract, a stale sibling is "logged,
    // 200-accepted, and reported in stale[]" — its id appears in BOTH
    // `accepted` and `stale`, never in `stale` alone. Confirmed against a
    // real local sync-worker (manual smoke test); modeling them as disjoint
    // here previously masked an ordering bug in flushQueue.
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          accepted: [{ id: "q1" }],
          rejected: [],
          stale: [{ id: "q1", fileId: "file1", cellId: "GEN 1:1" }],
        }),
        { status: 200 },
      ),
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await drainMicrotasks()

    await adapter.flushNow()

    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toBeUndefined()
    expect(getConflicts().has(cellRowId("proj1", "file1", "GEN 1:1", "target", DEFAULT_LANE_KEY))).toBe(true)

    adapter.close()
  })

  // A sync token is scoped to one file and the server 403s events for any
  // other file, so a single first-file token stranded offline edits to every
  // other file as "failed" (reproduced in the Tauri app, 2026-10-14).
  it("flushes each file's queued writes under a token minted for that file", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    store.commit(events.fileSynced({ id: "file2", projectId: "proj1", name: "Exodus", type: "usfm", sequenceIndex: 1 }))
    for (const [id, fileId] of [["q1", "file1"], ["q2", "file2"]] as const) {
      store.commit(
        events.eventQueued({
          id,
          projectId: "proj1",
          fileId,
          cellId: "1:1",
          kind: "target.cell.commit",
          payload: { value: "hola" },
          parentId: "head-1",
          author: "dev@local.test",
          schemaVersion: 1,
          clientTs: new Date(),
          createdAt: new Date(),
        }),
      )
    }
    const mintToken = vi.fn<MintToken>(async (_projectId, fileId) => ({ token: `tok-${fileId}`, status: null }))
    // Behaves like the server: refuses any event whose file the token isn't scoped to.
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).Authorization.replace("Bearer tok-", "")
      const evs = (JSON.parse(init.body as string) as { events: Array<{ id: string; fileId: string }> }).events
      return new Response(
        JSON.stringify({
          accepted: evs.filter((e) => e.fileId === token).map((e) => ({ id: e.id })),
          rejected: evs
            .filter((e) => e.fileId !== token)
            .map((e) => ({ id: e.id, status: 403, reason: "token scoped to different file" })),
          stale: [],
        }),
        { status: 200 },
      )
    })

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await drainMicrotasks()
    await adapter.flushNow()

    const posted = fetchImpl.mock.calls.map(([, init]) => ({
      auth: (init.headers as Record<string, string>).Authorization,
      ids: (JSON.parse(init.body as string) as { events: Array<{ id: string }> }).events.map((e) => e.id),
    }))
    expect(posted).toEqual(
      expect.arrayContaining([
        { auth: "Bearer tok-file1", ids: ["q1"] },
        { auth: "Bearer tok-file2", ids: ["q2"] },
      ]),
    )
    expect(store.query(tables.eventQueue.select().where({ projectId: "proj1" }))).toHaveLength(0)

    adapter.close()
  })

  it("leaves the queue pending when no local file exists yet to scope a token", async () => {
    store.commit(
      events.eventQueued({
        id: "q1",
        projectId: "proj1",
        fileId: "file1",
        cellId: "GEN 1:1",
        kind: "target.cell.commit",
        payload: { value: "hola" },
        parentId: "head-1",
        author: "dev@local.test",
        schemaVersion: 1,
        clientTs: new Date(),
        createdAt: new Date(),
      }),
    )
    const fetchImpl = vi.fn()

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await drainMicrotasks()

    await adapter.flushNow()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toMatchObject({ status: "pending" })

    adapter.close()
  })
})

// ── Flush triggering (AQU-1003 follow-up) ─────────────────────────────────
//
// The adapter used to flush ONLY from the reconciler's `onOpen`. On a desktop
// that is online and stays connected, the socket never reopens, so offline-
// routed writes (OFFLINE_ROUTABLE_KINDS in src/lib/sync/outbox.ts) sat in
// `event_queue` indefinitely while downstream kept working over the same open
// socket — "Tauri pulls changes down but never pushes them up".

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

function queueCommit(id: string): void {
  store.commit(
    events.eventQueued({
      id,
      projectId: "proj1",
      fileId: "file1",
      cellId: "GEN 1:1",
      kind: "target.cell.commit",
      payload: { value: "hola" },
      parentId: "head-1",
      author: "dev@local.test",
      schemaVersion: 1,
      clientTs: new Date(),
      createdAt: new Date(),
    }),
  )
}

describe("flush triggering", () => {
  it("flushes a newly queued write without waiting for a reconnect", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: [{ id: "q1" }] }), { status: 200 }),
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
    })
    await drainMicrotasks()
    // The socket is already open and stays open — exactly the state in which
    // the old reconnect-only trigger never fired again.
    FakeWebSocket.instances[0].open()
    await drainMicrotasks()
    fetchImpl.mockClear()

    queueCommit("q1")

    await waitFor(() => fetchImpl.mock.calls.length > 0)
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toBeUndefined()

    adapter.close()
  })

  it("coalesces writes that land together into one POST", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: [{ id: "q1" }, { id: "q2" }] }), { status: 200 }),
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 30,
    })
    await drainMicrotasks()
    fetchImpl.mockClear()

    queueCommit("q1")
    queueCommit("q2")

    await waitFor(() => store.query(tables.eventQueue.select()).length === 0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual(["q1", "q2"])

    adapter.close()
  })

  it("retries a failed flush on a backoff rather than spinning", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline")
    })

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
      minFlushRetryMs: 20,
      maxFlushRetryMs: 500,
    })
    await drainMicrotasks()
    fetchImpl.mockClear()

    queueCommit("q1")

    // Retried at ~20ms, ~40ms, ~80ms: several attempts, nowhere near the
    // thousands a re-entrant subscription→flush→revert loop would produce.
    await waitFor(() => fetchImpl.mock.calls.length >= 2)
    await new Promise((r) => setTimeout(r, 150))
    expect(fetchImpl.mock.calls.length).toBeLessThan(12)
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toMatchObject({
      status: "pending",
    })

    adapter.close()
  })

  it("stops flushing once closed", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: [{ id: "q1" }] }), { status: 200 }),
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 10,
    })
    await drainMicrotasks()
    fetchImpl.mockClear()

    adapter.close()
    queueCommit("q1")
    await new Promise((r) => setTimeout(r, 60))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toMatchObject({
      status: "pending",
    })
  })
})

describe("flush on construction", () => {
  it("sends work queued by a previous session without waiting for the socket", async () => {
    // The relaunch case: the app was closed with unsynced writes still in
    // `event_queue`. Nothing opens the FakeWebSocket here and nothing calls
    // flushNow(), so the POST can only come from the construction-time arm.
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    queueCommit("q1")

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: [{ id: "q1" }] }), { status: 200 }),
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
    })

    await waitFor(() => fetchImpl.mock.calls.length > 0)
    expect(FakeWebSocket.instances[0].readyState).not.toBe(FakeWebSocket.OPEN)
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toBeUndefined()

    adapter.close()
  })
})

describe("catch-up", () => {
  it("runs a catch-up on open, after the flush, with a minted token", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    queueCommit("q1")
    const order: string[] = []
    const fetchImpl = vi.fn(async () => {
      order.push("flush")
      return new Response(JSON.stringify({ accepted: [{ id: "q1" }] }), { status: 200 })
    })
    vi.mocked(catchUpProject).mockImplementation(async () => {
      order.push("catch-up")
      return { filesChecked: 1, rowsChanged: 0 }
    })

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 10_000,
    })
    await drainMicrotasks()
    FakeWebSocket.instances[0].open()

    await waitFor(() => vi.mocked(catchUpProject).mock.calls.length > 0)
    expect(catchUpProject).toHaveBeenCalledWith(store, "proj1", "tok-1", undefined)
    expect(order).toEqual(["flush", "catch-up"])

    adapter.close()
  })

  it("coalesces catch-up requests made while one is running into one follow-up", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    let release: () => void = () => {}
    vi.mocked(catchUpProject).mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ filesChecked: 1, rowsChanged: 0 }))),
    )
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
    })

    const first = adapter.catchUpNow()
    await waitFor(() => vi.mocked(catchUpProject).mock.calls.length === 1)
    const second = adapter.catchUpNow()
    const third = adapter.catchUpNow()
    expect(third).toBe(second)

    release()
    await first
    await waitFor(() => vi.mocked(catchUpProject).mock.calls.length === 2)
    release()
    await second
    expect(catchUpProject).toHaveBeenCalledTimes(2)

    adapter.close()
  })

  it("stores every target lane's rows from a live frame, keyed per lane (AQU-1614)", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      frameCoalesceMs: 0,
    })
    await drainMicrotasks()
    const ws = FakeWebSocket.instances[0]
    ws.open()

    const row = (targetLang: string, value: string) => ({
      cellId: "GEN 1:1",
      side: "target",
      targetLang,
      value,
      valueHtml: null,
      eventId: `evt-${targetLang || "default"}`,
      sourceEventId: null,
      validated: false,
      aiDrafted: false,
      sequenceIndex: 0,
      canonicalRef: null,
    })
    ws.receive({
      t: "event.applied",
      id: "evt-1",
      kind: "target.cell.commit",
      project: "proj1",
      file: "file1",
      rows: [row("", "In the beginning"), row("es", "En el principio")],
    })
    await landFrames()

    const laneRow = (laneKey: string) =>
      store.query(
        tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "target", laneKey) }).first(),
      )
    expect(laneRow(DEFAULT_LANE_KEY)).toMatchObject({
      value: "In the beginning",
      eventId: "evt-default",
      targetLang: "",
    })
    expect(laneRow(localLaneKey(null, "es"))).toMatchObject({
      value: "En el principio",
      eventId: "evt-es",
      targetLang: "es",
    })
    // The second lane no longer overwrites the first: two rows, not one.
    expect(store.query(tables.cells.select().where({ projectId: "proj1", fileId: "file1" }))).toHaveLength(2)

    adapter.close()
  })

  it("keys a live frame's row by lanes.id once the server sends one (AQU-1614)", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      frameCoalesceMs: 0,
    })
    await drainMicrotasks()
    const ws = FakeWebSocket.instances[0]
    ws.open()

    ws.receive({
      t: "event.applied",
      id: "evt-1",
      kind: "target.cell.commit",
      project: "proj1",
      file: "file1",
      rows: [
        {
          cellId: "GEN 1:1",
          side: "target",
          targetLang: "es",
          laneId: "lane-es",
          value: "En el principio",
          valueHtml: null,
          eventId: "evt-es",
          sourceEventId: null,
          validated: false,
          aiDrafted: false,
          sequenceIndex: 0,
          canonicalRef: null,
        },
      ],
    })
    await landFrames()

    expect(
      store.query(
        tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "target", "lane-es") }).first(),
      ),
    ).toMatchObject({ value: "En el principio", laneId: "lane-es", targetLang: "es" })

    adapter.close()
  })
})

describe("startup recovery", () => {
  it("re-sends rows a previous session left at 'flushing'", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    queueCommit("q1")
    store.commit(events.eventQueueStatusSet({ id: "q1", status: "flushing" }))
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: [{ id: "q1" }] }), { status: 200 }),
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
    })

    await waitFor(() => fetchImpl.mock.calls.length > 0)
    expect(store.query(tables.eventQueue.select().where({ id: "q1" }).first())).toBeUndefined()

    adapter.close()
  })
})

// Project gone server-side (deleted, access removed, archived, frozen): every
// mint 403s. Before, catch-up returned silently and the flush retried forever,
// leaving the local copy "ready" but stale with nothing telling the user.
describe("project no longer available on the server", () => {
  beforeEach(() => {
    vi.mocked(catchUpProject).mockImplementation(async () => ({ filesChecked: 0, rowsChanged: 0 }))
  })

  it("marks the project unavailable on a mint 403 and keeps its queued writes", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    queueCommit("q1")
    const mintToken = vi.fn<MintToken>(async () => ({ token: null, status: 403 }))
    const fetchImpl = vi.fn()

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
      minFlushRetryMs: 10_000,
    })

    await waitFor(() => isProjectUnavailable("proj1"))
    await waitFor(() => store.query(tables.eventQueue.select().where({ id: "q1" }).first())?.status === "pending")
    expect(fetchImpl).not.toHaveBeenCalled()

    adapter.close()
  })

  it("clears the mark once a mint succeeds again (unarchived, access re-granted)", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    let status = 403
    const mintToken = vi.fn<MintToken>(async () =>
      status === 403 ? { token: null, status } : { token: "tok-1", status },
    )

    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      flushDebounceMs: 1,
    })
    await waitFor(() => isProjectUnavailable("proj1"))

    status = 200
    await adapter.catchUpNow()
    expect(isProjectUnavailable("proj1")).toBe(false)

    adapter.close()
  })

  it("does not treat an expired session or a server error as the project being gone", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    for (const status of [401, 503, null]) {
      const adapter = createOfflineSyncAdapter({
        projectId: "proj1",
        store,
        mintToken: async () => ({ token: null, status }),
        baseUrl: "https://sync.example.com",
        webSocketCtor: FakeWsCtor,
      })
      await adapter.catchUpNow()
      expect(isProjectUnavailable("proj1")).toBe(false)
      adapter.close()
    }
  })

  it("drops the mark when the adapter closes (offline copy removed)", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: async () => ({ token: null, status: 403 }),
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
    })
    await adapter.catchUpNow()
    expect(isProjectUnavailable("proj1")).toBe(true)

    adapter.close()
    expect(isProjectUnavailable("proj1")).toBe(false)
  })
})

describe("long offline stretches", () => {
  function fakeConnectivity(initial: boolean | null) {
    let online = initial
    const listeners = new Set<(online: boolean | null) => void>()
    return {
      current: () => online,
      subscribe(listener: (online: boolean | null) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      set(next: boolean) {
        online = next
        for (const listener of listeners) listener(next)
      },
    }
  }

  /** `count` writes, oldest first, inserted in reverse to prove the flush sorts. */
  function queueMany(count: number): string[] {
    const base = Date.parse("2026-10-01T00:00:00Z")
    const ids = Array.from({ length: count }, (_, i) => `q${String(i).padStart(4, "0")}`)
    for (const [i, id] of [...ids.entries()].reverse()) {
      store.commit(
        events.eventQueued({
          id,
          projectId: "proj1",
          fileId: "file1",
          cellId: `GEN 1:${i + 1}`,
          kind: "target.cell.commit",
          payload: { value: `v${i}` },
          parentId: `head-${i}`,
          author: "dev@local.test",
          schemaVersion: 1,
          clientTs: new Date(base + i * 1_000),
          createdAt: new Date(base + i * 1_000),
        }),
      )
    }
    return ids
  }

  const acceptAll = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { events: Array<{ id: string }> }
    return new Response(JSON.stringify({ accepted: body.events.map((e) => ({ id: e.id })) }), { status: 200 })
  }

  const postedIds = (fetchImpl: ReturnType<typeof vi.fn>) =>
    fetchImpl.mock.calls.map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { events: Array<{ id: string }> }).events.map((e) => e.id))

  const statusWrites = (commit: { mock: { calls: unknown[][] } }) =>
    commit.mock.calls.filter(([e]) => (e as { name: string }).name === "v1.EventQueueStatusSet").length

  it("attempts nothing and writes nothing while offline, then sends it all on reconnect", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const connectivity = fakeConnectivity(false)
    const fetchImpl = vi.fn(acceptAll)
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
      minFlushRetryMs: 5,
      connectivity,
    })
    const commit = vi.spyOn(store, "commit")
    const ids = queueMany(3)

    await new Promise((r) => setTimeout(r, 80))
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(statusWrites(commit)).toBe(0)

    connectivity.set(true)
    await waitFor(() => store.query(tables.eventQueue.select()).length === 0)
    expect(postedIds(fetchImpl)).toEqual([ids])
    expect(statusWrites(commit)).toBe(0)

    adapter.close()
  })

  const appliedRow = (i: number, eventId: string) => ({
    cellId: `GEN 1:${i + 1}`,
    side: "target" as const,
    value: `v${i}`,
    valueHtml: null,
    eventId,
    sourceEventId: null,
    validated: false,
    aiDrafted: false,
    sequenceIndex: i,
    canonicalRef: null,
  })

  /** Accepts every event and returns its projected row, like the real POST /events. */
  const acceptAllWithRows = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { events: Array<{ id: string }> }
    return new Response(
      JSON.stringify({
        accepted: body.events.map((e) => ({ id: e.id })),
        applied: body.events.map((e) => ({
          t: "event.applied",
          id: e.id,
          kind: "target.cell.commit",
          project: "proj1",
          file: "file1",
          rows: [appliedRow(Number(e.id.slice(1)), e.id)],
        })),
      }),
      { status: 200 },
    )
  }

  it("lands everything one POST resolves in a single commit of batched events", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const connectivity = fakeConnectivity(false)
    const fetchImpl = vi.fn(acceptAllWithRows)
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
      connectivity,
    })
    queueMany(250)
    const commit = vi.spyOn(store, "commit")

    connectivity.set(true)
    await waitFor(() => store.query(tables.eventQueue.select()).length === 0, 5_000)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const names = commit.mock.calls.map((args) => args.map((e) => (e as { name: string }).name))
    expect(names).toEqual([
      ["v1.EventsDequeued", "v2.CellsSynced"],
      ["v1.EventsDequeued", "v2.CellsSynced"],
    ])
    expect(store.query(tables.cells.select().where({ projectId: "proj1", side: "target" }))).toHaveLength(250)

    adapter.close()
  })

  it("writes nothing for a live echo of rows the flush already landed", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: vi.fn(acceptAllWithRows) as unknown as typeof fetch,
      flushDebounceMs: 1,
      frameCoalesceMs: 0,
    })
    await drainMicrotasks()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    const [id] = queueMany(1)
    await waitFor(() => store.query(tables.eventQueue.select()).length === 0)
    const commit = vi.spyOn(store, "commit")

    const echo = { t: "event.applied", id, kind: "target.cell.commit", project: "proj1", file: "file1" }
    ws.receive({ ...echo, rows: [appliedRow(0, id)] })
    await landFrames()
    expect(commit).not.toHaveBeenCalled()

    // A row that did change still lands.
    ws.receive({ ...echo, id: "peer-1", rows: [{ ...appliedRow(0, "peer-1"), value: "peer edit" }] })
    await landFrames()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(
      store.query(tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "target", DEFAULT_LANE_KEY) }).first()),
    ).toMatchObject({ value: "peer edit", eventId: "peer-1" })

    adapter.close()
  })

  it("lands a burst of live frames as one commit, dequeuing our own writes", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const connectivity = fakeConnectivity(false)
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      connectivity,
      frameCoalesceMs: 20,
    })
    await drainMicrotasks()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    // Our writes, echoed while their POST is still in flight, plus a peer's.
    const ids = queueMany(50)
    const commit = vi.spyOn(store, "commit")
    for (const [i, id] of ids.entries()) {
      ws.receive({ t: "event.applied", id, kind: "target.cell.commit", project: "proj1", file: "file1", rows: [appliedRow(i, id)] })
    }
    ws.receive({ t: "event.applied", id: "peer-1", kind: "target.cell.commit", project: "proj1", file: "file1", rows: [appliedRow(60, "peer-1")] })
    expect(commit).not.toHaveBeenCalled()

    await waitFor(() => commit.mock.calls.length > 0)
    expect(commit.mock.calls.map((args) => args.map((e) => (e as { name: string }).name))).toEqual([
      ["v1.EventsDequeued", "v2.CellsSynced"],
    ])
    expect(store.query(tables.eventQueue.select())).toHaveLength(0)
    expect(store.query(tables.cells.select().where({ projectId: "proj1", side: "target" }))).toHaveLength(51)

    adapter.close()
  })

  it("drops buffered live frames when closed, so a removed copy stays removed", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      frameCoalesceMs: 10,
    })
    await drainMicrotasks()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive({ t: "event.applied", id: "peer-1", kind: "target.cell.commit", project: "proj1", file: "file1", rows: [appliedRow(0, "peer-1")] })
    adapter.close()

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(store.query(tables.cells.select())).toHaveLength(0)
  })

  it(`sends a big backlog oldest first, at most ${MAX_FLUSH_BATCH} per POST`, async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const connectivity = fakeConnectivity(false)
    const fetchImpl = vi.fn(acceptAll)
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
      connectivity,
    })
    const ids = queueMany(450)

    connectivity.set(true)
    await waitFor(() => store.query(tables.eventQueue.select()).length === 0, 5_000)
    const batches = postedIds(fetchImpl)
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50])
    expect(batches.flat()).toEqual(ids)

    adapter.close()
  })

  it("stops at the first failed batch, keeping order, without touching row status", async () => {
    store.commit(events.fileSynced({ id: "file1", projectId: "proj1", name: "Genesis", type: "usfm", sequenceIndex: 0 }))
    const connectivity = fakeConnectivity(false)
    let call = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      call += 1
      return call === 2 ? new Response("unavailable", { status: 503 }) : acceptAll(url, init)
    })
    const adapter = createOfflineSyncAdapter({
      projectId: "proj1",
      store,
      mintToken: okMint,
      baseUrl: "https://sync.example.com",
      webSocketCtor: FakeWsCtor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushDebounceMs: 1,
      minFlushRetryMs: 60_000,
      connectivity,
    })
    const commit = vi.spyOn(store, "commit")
    const ids = queueMany(450)

    connectivity.set(true)
    await waitFor(() => fetchImpl.mock.calls.length === 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchImpl).toHaveBeenCalledTimes(2) // the third batch waits behind the second
    const left = store.query(tables.eventQueue.select()).map((r) => r.id).sort()
    expect(left).toEqual(ids.slice(200))
    expect(store.query(tables.eventQueue.select()).every((r) => r.status === "pending")).toBe(true)
    expect(statusWrites(commit)).toBe(0)

    adapter.close()
  })
})
