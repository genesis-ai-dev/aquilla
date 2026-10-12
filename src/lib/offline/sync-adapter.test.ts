import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { schema, tables, events, cellRowId, DEFAULT_LANE_KEY, localLaneKey } from "./schema"
import { createOfflineSyncAdapter, type MintToken } from "./sync-adapter"
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
