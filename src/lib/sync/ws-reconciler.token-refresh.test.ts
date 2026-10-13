import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetHeartbeatForTests,
  createWsReconciler,
  tokenRefreshDelayMs,
  type WsReconciler,
} from "./ws-reconciler"

/**
 * AQU-1839: the DO no longer closes a socket at its sync token's expiry when the
 * client re-authorizes in band. These cover the client half of that handshake —
 * that a `token.expiry` frame arms exactly one refresh per expiry, that the
 * refresh carries a freshly minted token, and that a worker which never sends
 * the frame leaves the old close-and-reconnect behaviour untouched.
 */

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
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true } as CloseEvent)
  }
  refreshes(): string[] {
    return this.sent
      .map((s) => JSON.parse(s) as { t: string; token?: string })
      .filter((m) => m.t === "token.refresh")
      .map((m) => m.token ?? "")
  }
}

const FakeWsCtor = FakeWebSocket as unknown as typeof WebSocket
const LEAD_MS = 20_000
const TTL_MS = 15 * 60_000

let tokens: string[]

function makeReconciler(getToken?: () => Promise<string | null>): WsReconciler {
  return createWsReconciler({
    projectId: "p1",
    baseUrl: "https://sync.example.com",
    getToken: getToken ?? (async () => tokens.shift() ?? null),
    webSocketCtor: FakeWsCtor,
    // Off — this suite is about the refresh timer, and a ping every interval
    // only adds frames to filter out.
    heartbeatIntervalMs: 0,
    tokenRefreshLeadMs: LEAD_MS,
  })
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
  tokens = ["tok-1", "tok-2", "tok-3", "tok-4"]
})

afterEach(() => {
  vi.useRealTimers()
})

describe("tokenRefreshDelayMs", () => {
  it("refreshes one lead time before expiry", () => {
    expect(tokenRefreshDelayMs(100_000, 0, 20_000)).toBe(80_000)
  })

  it("floors an expiry that is already due so a stale frame cannot spin the timer", () => {
    expect(tokenRefreshDelayMs(1_000, 10_000, 20_000)).toBe(1_000)
  })
})

describe("ws-reconciler in-band token refresh", () => {
  it("sends one refresh with a freshly minted token a lead time before expiry", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()
    // Handshake token was tok-1; the DO reports when this connection lapses.
    const expiresAt = Date.now() + TTL_MS
    ws.receive({ t: "token.expiry", expiresAt })

    await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS - 1)
    expect(ws.refreshes()).toEqual([])

    await vi.advanceTimersByTimeAsync(2)
    expect(ws.refreshes()).toEqual(["tok-2"])
    // The socket is the same one — no reconnect, so no second FakeWebSocket.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.closedWith).toBeNull()
    rec.close()
  })

  it("keeps one socket across several token lifetimes as the server extends the expiry", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()

    for (let i = 0; i < 3; i++) {
      ws.receive({ t: "token.expiry", expiresAt: Date.now() + TTL_MS })
      await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS + 1)
    }

    expect(ws.refreshes()).toEqual(["tok-2", "tok-3", "tok-4"])
    expect(FakeWebSocket.instances).toHaveLength(1)
    rec.close()
  })

  it("does not schedule anything when the server sends no expiry frame (older worker)", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()

    await vi.advanceTimersByTimeAsync(TTL_MS * 2)
    expect(ws.refreshes()).toEqual([])
    rec.close()
  })

  it("does not schedule a refresh for a connection with no token (dev bypass)", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()
    ws.receive({ t: "token.expiry", expiresAt: null })

    await vi.advanceTimersByTimeAsync(TTL_MS * 2)
    expect(ws.refreshes()).toEqual([])
    rec.close()
  })

  it("retries a bounded number of times while the server keeps reporting the same expiry", async () => {
    const rec = makeReconciler(async () => "tok-same")
    const ws = await openFirstSocket()
    const expiresAt = Date.now() + TTL_MS
    ws.receive({ t: "token.expiry", expiresAt })

    await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS + 1)
    expect(ws.refreshes()).toHaveLength(1)
    // A refusal is silent, so the client retries — then gives up rather than
    // hammering the socket until expiry, and lets the server's close land.
    await vi.advanceTimersByTimeAsync(LEAD_MS * 4)
    expect(ws.refreshes()).toHaveLength(3)
    rec.close()
  })

  it("stops refreshing once the socket closes", async () => {
    const rec = makeReconciler()
    const ws = await openFirstSocket()
    ws.receive({ t: "token.expiry", expiresAt: Date.now() + TTL_MS })
    ws.close(1006, "dropped")

    await vi.advanceTimersByTimeAsync(TTL_MS)
    expect(ws.refreshes()).toEqual([])
    rec.close()
  })

  it("never surfaces the expiry frame to consumers", async () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const rec = createWsReconciler(
      {
        projectId: "p1",
        baseUrl: "https://sync.example.com",
        getToken: async () => "tok",
        webSocketCtor: FakeWsCtor,
        heartbeatIntervalMs: 0,
      },
      { onMessage, onError },
    )
    const ws = await openFirstSocket()
    ws.receive({ t: "token.expiry", expiresAt: Date.now() + TTL_MS })

    expect(onMessage).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    rec.close()
  })
})
