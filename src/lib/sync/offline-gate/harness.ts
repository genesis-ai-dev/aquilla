// Offline-sync gate: the edges the harness fakes, and nothing else.
//
// Everything between these edges is the product: the IndexedDB outbox
// (fake-indexeddb, real code), its recovery journal, the HTTP flush, the
// sync-token minter, the flusher hook and its Web-Lock cycle, and the
// WebSocket reconciler. What is faked here:
//
//   GateServer        `fetch` (POST /events, POST /sync-token) and the project
//                     socket. It keeps the log of every event it accepted.
//   FakeLocks         navigator.locks (happy-dom ships none that works).
//   IdbOpenGate       `indexedDB.open`, only to freeze a page before its
//                     transaction lands (the teardown the journal exists for).
//   settle()          "nothing left to run": no fetch in flight, no IndexedDB
//                     task queued. Fake timers stand still unless a scenario
//                     advances them, so this is a state, never a delay.
//   WsFirstSender     NOT a product module. See its comment.

import { vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { OutboxRawEvent } from "../outbox-types"
import type { OutboxRecord } from "../outbox"
import type { TokenMintResult } from "../outbox-flush"
import type { WsReconciler } from "../ws-reconciler"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"

export const OUTBOX_DB = "aquilla-cqrs-outbox"
export const OUTBOX_STORE = "outbox"
export const AUTH_URL = "http://127.0.0.1:8788/identity"
export const FLUSH_LOCK = "aquilla-cqrs-outbox-flush"
const JOURNAL_PREFIXES = ["aquilla:outbox-recovery:v1:", "aquilla:outbox-recovery:batch:v1:"]

// ── Quiescence ────────────────────────────────────────────────────────────

const nativeSetImmediate = globalThis.setImmediate
const nativeClearImmediate = globalThis.clearImmediate
const queuedImmediates = new Set<NodeJS.Immediate>()

/** fake-indexeddb runs every request on `setImmediate`. Counting the queued
 *  ones is how `settle` knows the outbox has nothing left in motion. */
export function installImmediateCounter(): () => void {
  const counting = (fn: (...args: unknown[]) => void, ...args: unknown[]): NodeJS.Immediate => {
    const handle = nativeSetImmediate(() => {
      queuedImmediates.delete(handle)
      fn(...args)
    })
    queuedImmediates.add(handle)
    return handle
  }
  globalThis.setImmediate = counting as unknown as typeof setImmediate
  globalThis.clearImmediate = ((handle: NodeJS.Immediate | undefined) => {
    if (handle) queuedImmediates.delete(handle)
    nativeClearImmediate(handle)
  }) as typeof clearImmediate
  return () => {
    globalThis.setImmediate = nativeSetImmediate
    globalThis.clearImmediate = nativeClearImmediate
    queuedImmediates.clear()
  }
}

/**
 * Resolve once the system has no work left: two event-loop turns in a row
 * with no IndexedDB task queued and no request in flight. The microtask queue
 * drains completely between turns, so two calm turns mean nothing can move
 * until a scenario step moves it. The deadline is a stall watchdog.
 */
export async function settle(server: GateServer, what: string): Promise<void> {
  const deadline = performance.now() + STALL_WATCHDOG_MS
  let calm = 0
  while (calm < 2) {
    await new Promise<void>((resolve) => nativeSetImmediate(resolve))
    calm = queuedImmediates.size === 0 && server.inFlight === 0 ? calm + 1 : 0
    if (performance.now() > deadline) {
      throw new Error(
        `offline-gate: never went quiet after ${what} ` +
          `(${server.inFlight} request(s) in flight, ${queuedImmediates.size} IndexedDB task(s) queued)`,
      )
    }
  }
}

// ── Web Locks ─────────────────────────────────────────────────────────────

function abortError(): Error {
  return new DOMException("The request was aborted", "AbortError")
}

/** Exclusive-mode Web Locks, shared by every tab of a scenario. */
export class FakeLocks {
  private held = new Map<string, symbol>()
  private waiting: Array<{ name: string; grant: () => void }> = []

  request(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
    maybeCallback?: LockGrantedCallback<unknown>,
  ): Promise<unknown> {
    const options: LockOptions = typeof optionsOrCallback === "function" ? {} : optionsOrCallback
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    return new Promise((resolve, reject) => {
      if (!callback) return reject(new TypeError("lock callback missing"))
      if (options.signal?.aborted) return reject(abortError())
      const grant = () => {
        const token = Symbol(name)
        this.held.set(name, token)
        Promise.resolve()
          .then(() => callback({ name, mode: "exclusive" }))
          .then(resolve, reject)
          .finally(() => this.release(name, token))
      }
      if (!this.held.has(name)) return grant()
      const entry = { name, grant }
      this.waiting.push(entry)
      options.signal?.addEventListener("abort", () => {
        const at = this.waiting.indexOf(entry)
        if (at < 0) return
        this.waiting.splice(at, 1)
        reject(abortError())
      })
    })
  }

  private release(name: string, token: symbol): void {
    if (this.held.get(name) !== token) return
    this.held.delete(name)
    const next = this.waiting.findIndex((entry) => entry.name === name)
    if (next >= 0) this.waiting.splice(next, 1)[0].grant()
  }

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held.keys()].map((name) => ({ name, mode: "exclusive" as const })),
      pending: this.waiting.map(({ name }) => ({ name, mode: "exclusive" as const })),
    }
  }

  /** The page died: the browser frees every lock it held or was waiting on.
   *  Only called while the dying page is the scenario's only live one. */
  freeAll(): void {
    this.held.clear()
    this.waiting = []
  }
}

// ── indexedDB.open gate ───────────────────────────────────────────────────

/**
 * Holds `indexedDB.open` calls back. A page whose open never completes has
 * journaled its commit (synchronous localStorage) but not stored it — the
 * exact window `outbox-recovery.ts` covers.
 */
export class IdbOpenGate {
  private readonly original = indexedDB.open
  private readonly nativeOpen = indexedDB.open.bind(indexedDB)
  private parked: Array<() => void> = []
  private intercepting = false

  hold(): void {
    this.intercepting = true
    indexedDB.open = (name: string, version?: number): IDBOpenDBRequest => {
      const proxy: {
        result?: IDBDatabase
        transaction?: IDBTransaction | null
        error?: DOMException | null
        onsuccess?: ((ev: Event) => void) | null
        onerror?: ((ev: Event) => void) | null
        onupgradeneeded?: ((ev: IDBVersionChangeEvent) => void) | null
      } = {}
      this.parked.push(() => {
        const real = this.nativeOpen(name, version)
        real.onupgradeneeded = (ev) => {
          proxy.result = real.result
          proxy.transaction = real.transaction
          proxy.onupgradeneeded?.(ev)
        }
        real.onsuccess = (ev) => {
          proxy.result = real.result
          proxy.onsuccess?.(ev)
        }
        real.onerror = (ev) => {
          proxy.error = real.error
          proxy.onerror?.(ev)
        }
      })
      return proxy as unknown as IDBOpenDBRequest
    }
  }

  /** True while a page's open is being held back (or was, and never ran). */
  get holding(): boolean {
    return this.intercepting || this.parked.length > 0
  }

  /** New opens complete again; the ones already held stay held. */
  pass(): void {
    this.intercepting = false
    indexedDB.open = this.original
  }

  /** The held opens complete: the page was slow, not dead. */
  proceed(): void {
    this.pass()
    const parked = this.parked
    this.parked = []
    for (const open of parked) open()
  }

  /** The held opens never complete: the page is gone. */
  abandon(): void {
    this.pass()
    this.parked = []
  }
}

// ── The fake server ───────────────────────────────────────────────────────

type Counted = { times?: number | "always" }

/** One scripted answer to a `POST /events`. Consumed in order; `file` / `id`
 *  limit a fault to batches that carry that file / that event. */
export type EventsFault = Counted & { file?: string; id?: string } & (
  /** The whole request answers this status. Nothing is committed. */
  | { type: "http"; status: number; body?: string }
  /** The connection dies. `commit` says how much of the batch the server had
   *  already committed when it did: none, all, or the first N events. */
  | { type: "drop"; commit: "none" | "all" | number; error: "network" | "timeout" }
  /** 200, with these events in `rejected[]` (the rest are processed). */
  | { type: "reject"; status: number; reason: string; ids: readonly string[] | "all" }
  /** 200 that neither accepts nor rejects these events. */
  | { type: "silent"; ids: readonly string[] }
  /** 200 with a body that is not JSON. */
  | { type: "malformed"; commit: boolean }
  /** The request is parked until the scenario releases it (or forever). */
  | { type: "hang"; commit: boolean }
)

/** One scripted answer to a `POST /sync-token`. */
export type TokenFault = Counted & { status: number | "network"; body?: string; project?: string }

export interface AcceptedEvent {
  id: string
  via: "http" | "ws"
  /** Logged, but a stale sibling: its parent was not the cell's head. */
  stale: boolean
  /** The event exactly as it arrived the first time. */
  event: OutboxRawEvent
}

interface EventsResponseBody {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
  stale: Array<{ id: string; fileId: string | null; cellId: string | null }>
  applied: unknown[]
}

function fakeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as unknown as Response
}

function take<F extends Counted>(queue: F[], matches: (fault: F) => boolean): F | null {
  const at = queue.findIndex(matches)
  if (at < 0) return null
  const fault = queue[at]
  if (fault.times !== "always") {
    const left = (fault.times ?? 1) - 1
    if (left <= 0) queue.splice(at, 1)
    else fault.times = left
  }
  return fault
}

const CHAIN_KIND = /^(source|target)\.cell\.(create|commit|delete|reorder)$/

/**
 * The network edge. Idempotent on event id like the real `/events` INSERT,
 * with the head compare-and-swap for chain-mutating kinds (a stale sibling is
 * logged, 200-accepted and reported), and the same answers over the socket.
 */
export class GateServer {
  online = true
  inFlight = 0
  eventPosts = 0
  tokenMints = 0
  readonly log: AcceptedEvent[] = []
  readonly deliveries = new Map<string, number>()
  /** id → status of the permanent rejection the server answered (a 4xx other
   *  than 401/403). The one answer that makes removing an event legal. */
  readonly permanentlyRejected = new Map<string, number>()
  readonly validJwts = new Set<string>(["jwt-1"])
  readonly eventsFaults: EventsFault[] = []
  readonly tokenFaults: TokenFault[] = []
  wsUp = true
  /** Next socket only: process this many frames, ack this many, lose the rest. */
  wsLossy: { deliver: number; ack: number } | null = null

  private readonly accepted = new Set<string>()
  private readonly heads = new Map<string, string>()
  private readonly tokens = new Set<string>()
  private tokenSeq = 0
  private parked: Array<() => void> = []
  private sockets: GateSocket[] = []

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!this.online) throw new TypeError("Failed to fetch")
    this.inFlight++
    try {
      await Promise.resolve()
      if (url.endsWith("/api/v2/sync-token")) return this.mint(init)
      if (url.endsWith("/events")) return await this.events(init)
      return fakeResponse(503, "{}")
    } finally {
      this.inFlight--
    }
  }

  revokeTokens(): void {
    this.tokens.clear()
  }

  /** Let every parked request go on. */
  release(): void {
    const parked = this.parked
    this.parked = []
    for (const resume of parked) resume()
  }

  private mint(init: RequestInit | undefined): Response {
    this.tokenMints++
    const body = JSON.parse(String(init?.body ?? "{}")) as { projectId?: string }
    const fault = take(this.tokenFaults, (f) => !f.project || f.project === body.projectId)
    if (fault?.status === "network") throw new TypeError("Failed to fetch")
    if (fault) return fakeResponse(fault.status, fault.body ?? "")
    const jwt = bearerOf(init)
    if (!jwt || !this.validJwts.has(jwt)) return fakeResponse(401, '{"error":"invalid session"}')
    const token = `sync-token-${++this.tokenSeq}`
    this.tokens.add(token)
    return fakeResponse(200, JSON.stringify({
      token,
      expiresIn: 900,
      role: { level: 400, name: "contributor", source: "group" },
    }))
  }

  private async events(init: RequestInit | undefined): Promise<Response> {
    this.eventPosts++
    const batch = (JSON.parse(String(init?.body)) as { events: OutboxRawEvent[] }).events
    const fault = take(
      this.eventsFaults,
      (f) => (!f.file || batch.some((e) => e.fileId === f.file)) && (!f.id || batch.some((e) => e.id === f.id)),
    )
    if (fault?.type === "http") return fakeResponse(fault.status, fault.body ?? "")
    const token = bearerOf(init)
    if (!token || !this.tokens.has(token)) return fakeResponse(401, '{"error":"token expired"}')

    if (fault?.type === "drop") {
      const committed = fault.commit === "all" ? batch.length : fault.commit === "none" ? 0 : fault.commit
      this.process(batch.slice(0, committed), null, "http")
      throw fault.error === "timeout"
        ? new DOMException("The operation timed out", "TimeoutError")
        : new TypeError("Failed to fetch")
    }
    if (fault?.type === "malformed") {
      if (fault.commit) this.process(batch, null, "http")
      return fakeResponse(200, "<html>bad gateway</html>")
    }
    if (fault?.type === "hang") {
      const early = fault.commit ? this.process(batch, null, "http") : null
      this.inFlight--
      await new Promise<void>((resume) => this.parked.push(resume))
      this.inFlight++
      return fakeResponse(200, JSON.stringify(early ?? this.process(batch, null, "http")))
    }
    return fakeResponse(200, JSON.stringify(this.process(batch, fault, "http")))
  }

  private process(
    batch: readonly OutboxRawEvent[],
    fault: Extract<EventsFault, { type: "reject" | "silent" }> | null,
    via: "http" | "ws",
  ): EventsResponseBody {
    const body: EventsResponseBody = { accepted: [], rejected: [], stale: [], applied: [] }
    for (const event of batch) {
      this.deliveries.set(event.id, (this.deliveries.get(event.id) ?? 0) + 1)
      const named = fault && (fault.ids === "all" || fault.ids.includes(event.id))
      if (named && fault.type === "silent") continue
      if (named && fault.type === "reject" && !this.accepted.has(event.id)) {
        body.rejected.push({ id: event.id, status: fault.status, reason: fault.reason })
        const permanent = fault.status >= 400 && fault.status < 500 && fault.status !== 401 && fault.status !== 403
        if (permanent) this.permanentlyRejected.set(event.id, fault.status)
        continue
      }
      body.accepted.push({ id: event.id })
      // A replayed id is answered with a bare acceptance and has no effect.
      if (this.accepted.has(event.id)) continue
      this.accepted.add(event.id)
      const slot = `${event.projectId}|${event.fileId ?? ""}|${event.cellId ?? ""}|${event.kind.split(".")[0]}`
      const chained = CHAIN_KIND.test(event.kind)
      const head = this.heads.get(slot)
      const stale = chained && head !== undefined && event.parentId !== head
      if (chained && !stale) this.heads.set(slot, event.id)
      this.log.push({ id: event.id, via, stale, event: structuredClone(event) })
      if (stale) {
        body.stale.push({ id: event.id, fileId: event.fileId ?? null, cellId: event.cellId ?? null })
      } else {
        body.applied.push({
          t: "event.applied",
          id: event.id,
          kind: event.kind,
          project: event.projectId,
          ...(event.fileId ? { file: event.fileId } : {}),
          ...(event.cellId ? { cell: event.cellId } : {}),
          by: event.author,
          serverSeq: this.log.length,
        })
      }
    }
    return body
  }

  // ── The project socket ──────────────────────────────────────────────────

  socketCtor(): typeof WebSocket {
    const attach = (socket: GateSocket) => {
      const lossy = this.wsUp && this.online ? this.wsLossy : null
      if (lossy) this.wsLossy = null
      this.sockets.push(socket)
      queueMicrotask(() => {
        if (!this.wsUp || !this.online) return socket.close(1006, "unreachable")
        socket.readyState = GateSocket.OPEN
        socket.onopen?.(new Event("open"))
      })
      return (data: string) => {
        const frame = JSON.parse(data) as { t?: string; event?: OutboxRawEvent }
        if (frame.t !== "outbox.event" || !frame.event) return
        socket.received++
        if (lossy && socket.received > lossy.deliver) return
        const result = this.process([frame.event], null, "ws")
        if (lossy && socket.received > lossy.ack) return
        const stale = result.stale.length > 0
        const answer = stale
          ? { t: "event.stale", id: frame.event.id, reason: "stale sibling" }
          : (result.applied[0] ?? {
              t: "event.applied",
              id: frame.event.id,
              kind: frame.event.kind,
              project: frame.event.projectId,
            })
        queueMicrotask(() => {
          if (socket.readyState === GateSocket.OPEN) {
            socket.onmessage?.({ data: JSON.stringify(answer) } as MessageEvent)
          }
        })
      }
    }
    class Bound extends GateSocket {
      constructor(url: string) {
        super(url)
        this.deliver = attach(this)
      }
    }
    return Bound as unknown as typeof WebSocket
  }

  /** The link under every open socket goes away. */
  dropSockets(): void {
    for (const socket of this.sockets) socket.close(1006, "connection lost")
    this.sockets = []
  }
}

function bearerOf(init: RequestInit | undefined): string | null {
  const headers = init?.headers as Record<string, string> | undefined
  const value = headers?.Authorization
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : null
}

export class GateSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState: number = GateSocket.CONNECTING
  received = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  protected deliver: (data: string) => void = () => {}
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    if (this.readyState !== GateSocket.OPEN) throw new Error("socket is not open")
    this.deliver(data)
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === GateSocket.CLOSED) return
    this.readyState = GateSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent)
  }
}

// ── A tab ─────────────────────────────────────────────────────────────────

export interface Announcements {
  stale: string[]
  rejected: string[]
  forbidden: string[]
}

type FlusherView = ReturnType<typeof renderHook<unknown, { epoch: string | null }>>

/** One page: its own instance of every outbox module, over the IndexedDB,
 *  localStorage and Web Locks it shares with the scenario's other tabs. */
export interface Tab {
  name: string
  outbox: typeof import("../outbox")
  flush: typeof import("../outbox-flush")
  flusher: typeof import("@/hooks/useOutboxFlusher")
  ws: typeof import("../ws-reconciler")
  jwt: { current: string | null }
  /** The real per-(project, file) sync-token minter from cqrs-bridge. */
  mint: (projectId: string, fileId: string, opts?: { forceRefresh?: boolean }) => Promise<TokenMintResult>
  heard: Announcements
  hook: FlusherView | null
  sender: WsFirstSender | null
  /** The page was torn down; nothing it left running may be waited on. */
  dead: boolean
  /** Its `indexedDB.open` never completed, so it has no connection to close. */
  neverOpened: boolean
  /** Work the scenario started and did not await (label → settled?). */
  running: Array<{ what: string; done: boolean }>
  failures: string[]
}

export const ACCOUNT = "account-1"

export async function openTab(name: string, heard: Announcements): Promise<Tab> {
  // A fresh module registry is a fresh page: no open connection, no cached
  // sync token, no in-memory flush chain, no in-flight journal keys.
  vi.resetModules()
  const [outbox, flush, bridge, flusher, ws] = await Promise.all([
    import("../outbox"),
    import("../outbox-flush"),
    import("../cqrs-bridge"),
    import("@/hooks/useOutboxFlusher"),
    import("../ws-reconciler"),
  ])
  outbox.setActiveOutboxOwner(ACCOUNT)
  const jwt = { current: "jwt-1" as string | null }
  flush.subscribeStaleSiblings((entries) => heard.stale.push(...entries.map((e) => e.id)))
  flush.subscribeRejected((entries) => heard.rejected.push(...entries.map((e) => e.id)))
  return {
    name,
    outbox,
    flush,
    flusher,
    ws,
    jwt,
    mint: bridge.buildProjectAwareMinter(() => jwt.current, AUTH_URL),
    heard,
    hook: null,
    sender: null,
    dead: false,
    neverOpened: false,
    running: [],
    failures: [],
  }
}

/** Start work without awaiting it; `settle` is what waits. */
export function run(tab: Tab, what: string, work: Promise<unknown>): void {
  const entry = { what, done: false }
  tab.running.push(entry)
  work.then(
    () => { entry.done = true },
    (error: unknown) => {
      entry.done = true
      tab.failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

export function mountFlusher(tab: Tab): void {
  tab.hook = renderHook(
    ({ epoch }: { epoch: string | null }) =>
      tab.flusher.useOutboxFlusher({ enabled: true, getTokenForFile: tab.mint, authEpoch: epoch }),
    { initialProps: { epoch: tab.jwt.current } },
  )
}

// ── Reading the truth back ────────────────────────────────────────────────

/** Every record in the outbox store, read without any product code. */
export async function readOutboxRaw(): Promise<OutboxRecord[]> {
  const known = await indexedDB.databases()
  if (!known.some((db) => db.name === OUTBOX_DB)) return []
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(OUTBOX_DB)
    open.onerror = () => reject(open.error ?? new Error("raw outbox open failed"))
    open.onsuccess = () => {
      const db = open.result
      db.onversionchange = () => db.close()
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.close()
        resolve([])
        return
      }
      const all = db.transaction(OUTBOX_STORE, "readonly").objectStore(OUTBOX_STORE).getAll()
      all.onerror = () => reject(all.error ?? new Error("raw outbox read failed"))
      all.onsuccess = () => {
        db.close()
        resolve(all.result as OutboxRecord[])
      }
    }
  })
}

/** Ids of events that exist only in the reload-recovery journal. */
export function readJournalIds(): string[] {
  const ids: string[] = []
  for (const key of Object.keys(localStorage)) {
    if (!JOURNAL_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
      const id = (record as { id?: unknown } | null)?.id
      if (typeof id === "string") ids.push(id)
    }
  }
  return ids
}

export async function wipeOutbox(tabs: readonly Tab[]): Promise<void> {
  for (const tab of tabs) {
    tab.hook?.unmount()
    tab.sender?.close()
    if (!tab.neverOpened) await tab.outbox.resetOutboxConnectionForTests()
  }
  await new Promise<void>((resolve, reject) => {
    const drop = indexedDB.deleteDatabase(OUTBOX_DB)
    drop.onsuccess = () => resolve()
    drop.onblocked = () => resolve()
    drop.onerror = () => reject(drop.error ?? new Error("outbox delete failed"))
  })
  localStorage.clear()
  sessionStorage.clear()
}

// ── WebSocket-first sender (harness glue, not product) ────────────────────

/**
 * `ws-reconciler.ts` documents a write path in which "the reconciler ships
 * events over this WS when healthy and falls back to POST /events otherwise".
 * The reconciler exposes `send()` for it and the worker handles the frame
 * (`sync-worker/src/project-do.ts`, `outbox.event`), but no module under
 * `src/` builds that frame: the shipped client drains over HTTP only. So the
 * policy below is the harness's, written to be the strictest reading of that
 * comment, and what it exercises of the product is exactly the reconciler's
 * half of the contract:
 *
 *   - `send()` reports the truth (false unless the socket is OPEN);
 *   - a dropped socket reconnects on its own and `onOpen` fires again;
 *   - `event.applied` / `event.stale` frames reach `onMessage` parsed.
 *
 * Policy: an event leaves the outbox only on its own ack frame. A frame that
 * `send()` took is not re-sent on the same socket; once that socket closes,
 * everything unacked is offered again. When `send()` refuses, the real HTTP
 * drain runs.
 */
export class WsFirstSender {
  readonly reconciler: WsReconciler
  private sentOnSocket = new Map<string, number>()
  private socketNo = 0
  private readonly tab: Tab

  constructor(tab: Tab, socketCtor: typeof WebSocket) {
    this.tab = tab
    this.reconciler = tab.ws.createWsReconciler(
      {
        projectId: "P1",
        baseUrl: "http://127.0.0.1:8787",
        getToken: async () => (await tab.mint("P1", "__project__")).token,
        webSocketCtor: socketCtor,
        heartbeatIntervalMs: 0,
      },
      {
        onOpen: () => {
          this.socketNo++
          run(tab, "ws resend on open", this.pump())
        },
        // Whatever was in transit on the socket that just closed is unacked.
        onClose: () => {
          this.socketNo++
        },
        onMessage: (frame) => {
          if (frame.t !== "event.applied" && frame.t !== "event.stale") return
          if (!this.sentOnSocket.has(frame.id)) return
          this.sentOnSocket.delete(frame.id)
          if (frame.t === "event.stale") tab.heard.stale.push(frame.id)
          run(tab, `ws ack ${frame.id}`, tab.outbox.removeOutboxEvents([frame.id]))
        },
      },
    )
  }

  /** Offer every pending event to the socket; drain over HTTP if it refuses. */
  async pump(): Promise<void> {
    for (const record of await this.tab.outbox.peekPendingOutboxBatch(500)) {
      if (this.sentOnSocket.get(record.id) === this.socketNo) continue
      if (this.reconciler.send({ t: "outbox.event", event: record.event })) {
        this.sentOnSocket.set(record.id, this.socketNo)
        continue
      }
      await httpCycle(this.tab)
      return
    }
  }

  close(): void {
    this.reconciler.close()
  }
}

/** One pass of the real HTTP drain: `drainCycle` over `flushOutboxBatch`. */
export function httpCycle(tab: Tab): Promise<unknown> {
  return tab.flusher.drainCycle(() =>
    tab.flush.flushOutboxBatch({
      getTokenForFile: tab.mint,
      onForbidden: (entries) => tab.heard.forbidden.push(...entries.map((e) => e.id)),
    }),
  )
}
