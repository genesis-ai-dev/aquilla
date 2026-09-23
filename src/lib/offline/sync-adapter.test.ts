import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { createStorePromise, type Store } from "@livestore/livestore"
import { schema, tables, events, cellRowId } from "./schema"
import { createOfflineSyncAdapter, type MintToken } from "./sync-adapter"
import { __resetConflictsForTests, getConflicts } from "./conflicts"

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
      tables.cells.select().where({ id: cellRowId("proj1", "file1", "GEN 1:1", "target") }).first(),
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
    expect(getConflicts().has(cellRowId("proj1", "file1", "GEN 1:1", "target"))).toBe(true)

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
    expect(getConflicts().has(cellRowId("proj1", "file1", "GEN 1:1", "target"))).toBe(true)

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
