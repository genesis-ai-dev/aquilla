import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  buildProjectWsUrl,
  createWsReconciler,
  parseProjectWsMessage,
  type ProjectWsServerMessage,
} from "./ws-reconciler"

// ── Fake WebSocket harness ────────────────────────────────────────────────

interface FakeWsHandlers {
  onopen?: (this: WebSocket) => void
  onmessage?: (ev: MessageEvent) => void
  onclose?: (ev: CloseEvent) => void
  onerror?: (ev: Event) => void
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  url: string
  sent: string[] = []
  onopen: FakeWsHandlers["onopen"] | null = null
  onmessage: FakeWsHandlers["onmessage"] | null = null
  onclose: FakeWsHandlers["onclose"] | null = null
  onerror: FakeWsHandlers["onerror"] | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.call(this as unknown as WebSocket)
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("send called when not OPEN")
    }
    this.sent.push(data)
  }

  receive(payload: string): void {
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent)
  }

  errorOnce(): void {
    this.onerror?.({} as Event)
  }
}

// Make the fake satisfy the typeof WebSocket constraint loosely.
const FakeWsCtor = FakeWebSocket as unknown as typeof WebSocket

describe("buildProjectWsUrl", () => {
  it("upgrades https → wss and embeds token", () => {
    expect(buildProjectWsUrl("https://example.com", "proj-1", "tok")).toBe(
      "wss://example.com/parties/project-sync/proj-1?token=tok",
    )
  })

  it("upgrades http → ws for local dev", () => {
    expect(buildProjectWsUrl("http://127.0.0.1:8787", "p", null)).toBe(
      "ws://127.0.0.1:8787/parties/project-sync/p",
    )
  })

  it("accepts ws:// / wss:// inputs unchanged", () => {
    expect(buildProjectWsUrl("ws://localhost", "p", null)).toBe(
      "ws://localhost/parties/project-sync/p",
    )
  })

  it("appends user param so dev ALLOW_UNAUTHENTICATED identity matches the client", () => {
    expect(buildProjectWsUrl("http://localhost", "p", null, "ryder")).toBe(
      "ws://localhost/parties/project-sync/p?user=ryder",
    )
    expect(buildProjectWsUrl("https://example.com", "p", "tok", "ry der")).toBe(
      "wss://example.com/parties/project-sync/p?token=tok&user=ry%20der",
    )
  })
})

describe("parseProjectWsMessage", () => {
  it("parses event.applied", () => {
    const msg = parseProjectWsMessage(
      JSON.stringify({
        t: "event.applied",
        id: "evt-1",
        kind: "target.cell.commit",
        project: "p",
        file: "f",
        cell: "c",
      }),
    )
    expect(msg).toEqual({
      t: "event.applied",
      id: "evt-1",
      kind: "target.cell.commit",
      project: "p",
      file: "f",
      cell: "c",
    })
  })

  it("passes `by` through on event.applied so own-write banner suppression can fire", () => {
    // ProjectWorkspace guards `msg.by === currentUsername` to avoid popping
    // the "changed elsewhere" banner when our own commit bounces back over
    // WS. Dropping `by` here turns every own edit into a phantom remote
    // change while the cell is still focused.
    const msg = parseProjectWsMessage(
      JSON.stringify({
        t: "event.applied",
        id: "evt-1",
        kind: "target.cell.commit",
        project: "p",
        cell: "c",
        by: "alice",
      }),
    )
    expect(msg).toMatchObject({ t: "event.applied", by: "alice" })
  })

  it("parses event.stale", () => {
    expect(
      parseProjectWsMessage(
        JSON.stringify({ t: "event.stale", id: "x", reason: "parent mismatch" }),
      ),
    ).toEqual({ t: "event.stale", id: "x", reason: "parent mismatch" })
  })

  it("parses presence", () => {
    const msg = parseProjectWsMessage(
      JSON.stringify({
        t: "presence",
        users: [
          { userId: "alice", focusedCell: "c1", ts: 100 },
          { userId: "bob", ts: 200 },
        ],
      }),
    )
    expect(msg?.t).toBe("presence")
    if (msg?.t === "presence") {
      expect(msg.users).toHaveLength(2)
      expect(msg.users[0].focusedCell).toBe("c1")
      expect(msg.users[1].focusedCell).toBeUndefined()
    }
  })

  it("parses lock.claimed + lock.released", () => {
    const claim = parseProjectWsMessage(
      JSON.stringify({ t: "lock.claimed", cellId: "c", by: { userId: "alice", ts: 7 } }),
    )
    expect(claim).toEqual({
      t: "lock.claimed",
      cellId: "c",
      by: { userId: "alice", ts: 7 },
    })
    const release = parseProjectWsMessage(
      JSON.stringify({ t: "lock.released", cellId: "c", by: { userId: "alice", ts: 9 } }),
    )
    expect(release?.t).toBe("lock.released")
  })

  it("returns null on malformed frames", () => {
    expect(parseProjectWsMessage("not json")).toBeNull()
    expect(parseProjectWsMessage(JSON.stringify({ t: "unknown" }))).toBeNull()
    expect(parseProjectWsMessage(JSON.stringify({ t: "event.applied", id: 1 }))).toBeNull()
    expect(parseProjectWsMessage(JSON.stringify({ t: "presence", users: "wrong" }))).toBeNull()
  })
})

describe("createWsReconciler", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("connects on next tick and emits onOpen", async () => {
    const onOpen = vi.fn()
    const r = createWsReconciler(
      {
        projectId: "p",
        baseUrl: "https://example.com",
        getToken: async () => "tok",
        webSocketCtor: FakeWsCtor,
      },
      { onOpen },
    )
    // queueMicrotask schedules connect; wait for it.
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()
    expect(ws.url).toContain("wss://example.com/parties/project-sync/p")
    expect(ws.url).toContain("token=tok")
    ws.open()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(r.isConnected()).toBe(true)
    r.close()
  })

  it("delivers parsed server frames to onMessage", async () => {
    const onMessage = vi.fn()
    const r = createWsReconciler(
      {
        projectId: "p",
        baseUrl: "https://example.com",
        getToken: async () => "tok",
        webSocketCtor: FakeWsCtor,
      },
      { onMessage },
    )
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive(
      JSON.stringify({
        t: "event.applied",
        id: "e1",
        kind: "target.cell.commit",
        project: "p",
        file: "f",
        cell: "c",
      }),
    )
    expect(onMessage).toHaveBeenCalledTimes(1)
    const msg = onMessage.mock.calls[0][0] as ProjectWsServerMessage
    expect(msg.t).toBe("event.applied")
    if (msg.t === "event.applied") {
      expect(msg.id).toBe("e1")
      expect(msg.cell).toBe("c")
    }
    r.close()
  })

  it("emits onError when the server sends an unparseable frame", async () => {
    const onError = vi.fn()
    const r = createWsReconciler(
      {
        projectId: "p",
        baseUrl: "https://example.com",
        getToken: async () => "tok",
        webSocketCtor: FakeWsCtor,
      },
      { onError },
    )
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.receive("not-json")
    expect(onError).toHaveBeenCalled()
    r.close()
  })

  it("send returns false when not OPEN", async () => {
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
    })
    expect(
      r.send({ t: "focus.claim", cellId: "c", leaseMs: 30000 }),
    ).toBe(false)
    r.close()
  })

  it("send forwards a JSON-encoded frame when OPEN", async () => {
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
    })
    await Promise.resolve()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    expect(r.send({ t: "focus.claim", cellId: "c-1" })).toBe(true)
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({ t: "focus.claim", cellId: "c-1" })
    r.close()
  })

  it("reconnects with backoff on close", async () => {
    vi.useFakeTimers()
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
      minBackoffMs: 100,
      maxBackoffMs: 1_000,
    })
    // Initial connect is via queueMicrotask. Drain microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].close(1006, "drop")
    // Backoff timer queued; advance to fire it.
    await vi.advanceTimersByTimeAsync(150)
    // Microtask drain inside reconnect path.
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    r.close()
  })

  it("close() prevents further reconnects", async () => {
    vi.useFakeTimers()
    const r = createWsReconciler({
      projectId: "p",
      baseUrl: "https://example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
      minBackoffMs: 50,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    r.close()
    FakeWebSocket.instances[0].close(1006, "")
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
