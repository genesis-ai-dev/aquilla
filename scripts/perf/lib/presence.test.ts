/**
 * Regression guards for the presence-load accounting (AQU-1868).
 *
 * The numbers this module reports are the only evidence a presence change is
 * an improvement, so a wrong number here is worse than a crash: it reads as a
 * finding. These drive `runPresenceLoad` against a fake WebSocket — no stack,
 * no network — because both bugs below were in the bookkeeping, not in the
 * transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runPresenceLoad } from "./presence"

type Listener = (event: unknown) => void

/** Opens, answers `ping` with the `pong` echo the project DO sends, closes on demand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 0
  url: string
  sent: string[] = []
  private listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.emit("open", {})
    }, 0)
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(raw: string): void {
    this.sent.push(raw)
    const frame = JSON.parse(raw) as { t: string; ts?: number }
    if (frame.t === "ping") {
      this.emit("message", { data: JSON.stringify({ t: "pong", ts: frame.ts }) })
    }
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit("close", { code })
  }

  /** Simulate the server dropping this socket mid-run. */
  dropFromServer(code = 1006): void {
    this.readyState = 3
    this.emit("close", { code })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const options = (sockets: number) => ({
  target: { authBase: "http://auth.test", syncBase: "http://sync.test" },
  jwt: "jwt",
  projectId: "project-1",
  fileId: "file-1",
  username: "dev",
  sockets,
  durationMs: 120,
  pingIntervalMs: 40,
  updateIntervalMs: 40,
  staggerMs: 0,
  cellIds: ["GEN 1:1", "GEN 1:2"],
})

let realWebSocket: typeof globalThis.WebSocket | undefined
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  FakeWebSocket.instances = []
  realWebSocket = globalThis.WebSocket
  realFetch = globalThis.fetch
  globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
  // mintSyncToken is the one HTTP call the load makes before opening sockets.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ token: "sync-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof globalThis.fetch
})

afterEach(() => {
  if (realWebSocket) globalThis.WebSocket = realWebSocket
  globalThis.fetch = realFetch
})

describe("runPresenceLoad", () => {
  it("does not count its own shutdown as sockets dropping out", async () => {
    // The bug: every socket fires `close` when the harness closes it at the
    // end, so a perfect run reported "closed early 50" out of 50.
    const result = await runPresenceLoad(options(5))
    expect(result.socketsOpen).toBe(5)
    expect(result.socketsClosedEarly).toBe(0)
  })

  it("still counts a socket the server dropped mid-run", async () => {
    const run = runPresenceLoad(options(4))
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4))
    await vi.waitFor(() => expect(FakeWebSocket.instances[0].readyState).toBe(1))
    FakeWebSocket.instances[0].dropFromServer()
    const result = await run
    expect(result.socketsClosedEarly).toBe(1)
    expect(result.closeCodes["1006"]).toBe(1)
  })

  it("measures round trips from the DO's pong echo", async () => {
    const result = await runPresenceLoad(options(3))
    expect(result.pongsReceived).toBeGreaterThan(0)
    expect(result.ping.count).toBe(result.pongsReceived)
    expect(result.framesReceived).toBeGreaterThanOrEqual(result.pongsReceived)
  })

  it("publishes presence updates on every live socket", async () => {
    const result = await runPresenceLoad(options(3))
    expect(result.updatesSent).toBeGreaterThan(0)
    const frames = FakeWebSocket.instances.flatMap((socket) =>
      socket.sent.map((raw) => JSON.parse(raw) as { t: string }),
    )
    expect(frames.some((frame) => frame.t === "presence.update")).toBe(true)
  })

  it("says what to do when this Node has no global WebSocket", async () => {
    // Node 20 threw a bare "WebSocket is not defined" from inside the open loop.
    // @ts-expect-error — deleting the global is the condition under test.
    delete globalThis.WebSocket
    await expect(runPresenceLoad(options(2))).rejects.toThrow(/no global WebSocket/)
  })
})
