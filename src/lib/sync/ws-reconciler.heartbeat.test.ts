import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetHeartbeatForTests, createWsReconciler, type WsReconcilerHandlers } from "./ws-reconciler"

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  sent: string[] = []
  closedWith: { code?: number; reason?: string } | null = null
  onopen: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  send(data: string): void {
    this.sent.push(data)
  }
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent)
  }
  /** A half-open socket: close() is accepted but no close event ever arrives. */
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
  }
  pings(): number {
    return this.sent.filter((s) => (JSON.parse(s) as { t: string }).t === "ping").length
  }
}

const FakeWsCtor = FakeWebSocket as unknown as typeof WebSocket
const INTERVAL = 1_000
const TIMEOUT = 500

function makeReconciler(handlers: WsReconcilerHandlers = {}) {
  return createWsReconciler(
    {
      projectId: "p1",
      baseUrl: "https://sync.example.com",
      getToken: async () => "tok",
      webSocketCtor: FakeWsCtor,
      heartbeatIntervalMs: INTERVAL,
      heartbeatTimeoutMs: TIMEOUT,
    },
    handlers,
  )
}

async function openFirstSocket(): Promise<FakeWebSocket> {
  await vi.advanceTimersByTimeAsync(0)
  const ws = FakeWebSocket.instances[0]
  ws.open()
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  __resetHeartbeatForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("ws-reconciler heartbeat", () => {
  it("pings on every interval while open", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(ws.pings()).toBe(3)
    expect(JSON.parse(ws.sent[0])).toMatchObject({ t: "ping", ts: expect.any(Number) })
    rec.close()
  })

  it("does not drop a silent socket until the server has proven it answers pings", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()

    await vi.advanceTimersByTimeAsync(INTERVAL * 10)
    expect(ws.closedWith).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(1)
    rec.close()
  })

  it("drops a socket that goes silent after pongs were seen, and reconnects at once", async () => {
    const onClose = vi.fn()
    const onError = vi.fn()
    const rec = makeReconciler({ onClose, onError })
    const ws = await openFirstSocket()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    ws.receive({ t: "pong" })
    // Now silent: next ping goes unanswered past the timeout.
    await vi.advanceTimersByTimeAsync(INTERVAL + TIMEOUT)

    expect(ws.closedWith).toEqual({ code: 4000, reason: "heartbeat timeout" })
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 4000 }))
    expect(onError).toHaveBeenCalledWith(new Error("ws: heartbeat timeout"))
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(2)
    rec.close()
  })

  it("counts any frame as liveness, not just a pong", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    ws.receive({ t: "pong" })

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(INTERVAL)
      ws.receive({ t: "presence", users: [] })
    }
    expect(ws.closedWith).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(1)
    rec.close()
  })

  it("keeps pongs away from onMessage and onError", async () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const rec = makeReconciler({ onMessage, onError })
    const ws = await openFirstSocket()

    ws.receive({ t: "pong", ts: 123 })
    expect(onMessage).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    rec.close()
  })

  it("stops pinging once closed", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()
    rec.close()
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    expect(ws.pings()).toBe(0)
  })
})
