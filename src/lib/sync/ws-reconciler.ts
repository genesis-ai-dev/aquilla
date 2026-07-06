/**
 * WebSocket client for the per-project Durable Object (Phase 2c).
 *
 * Per AD-1: the DO holds only transient state — focus-lock leases,
 * presence, and the live event broadcast. Per AD-3: writes flow via the
 * outbox; the reconciler ships events over this WS when healthy and
 * falls back to POST `/events` otherwise.
 *
 * Server protocol (mirror of `sync-worker/src/project-do.ts`):
 *
 *   ── Server → client ────────────────────────────────────────────────
 *   { t: "event.applied", id, kind, project, file?, cell? }
 *       Server projected a winning event. Triggers revalidate of useCells,
 *       useCellHistory, etc.
 *   { t: "event.stale", id, reason }
 *       Server rejected an incoming event as a stale sibling (parent-chain
 *       mismatch). Outbox uses this to dead-letter.
 *   { t: "presence", users: [{ userId, focusedCell?, ts }] }
 *       Roster snapshot. Sent on connect + on roster change.
 *   { t: "lock.claimed", cellId, by: { userId, ts } }
 *   { t: "lock.released", cellId, by: { userId, ts } }
 *       Focus-lock transitions by another user.
 *   { t: "link.upstream-changed", project, upstream, untilSeq, fileIds, cellIds }
 *       FRO-479 push accelerator: this project's live upstream committed
 *       lane-relevant changes. LOSSY — never load-bearing (see
 *       docs/superpowers/specs/2026-07-06-linked-projects-provenance-invalidation-design.md
 *       §8). A missed frame self-heals via the FRO-476 lazy-pull mirror sync
 *       on next file open; this is purely a latency accelerator for
 *       already-connected clients.
 *
 *   ── Client → server ────────────────────────────────────────────────
 *   { t: "outbox.event", event: OutboxRawEvent }
 *   { t: "focus.claim", cellId, leaseMs?: number }
 *   { t: "focus.renew", cellId }
 *   { t: "focus.release", cellId }
 *
 * This file is the *client*. The server-side DO ships in
 * `sync-worker/src/project-do.ts`. Both must remain wire-compatible.
 */

import type { OutboxRawEvent, OutboxEventKind } from "./outbox-types"

export interface PresenceUser {
  userId: string
  focusedCell?: string
  ts: number
}

export type ProjectWsServerMessage =
  | {
      t: "event.applied"
      id: string
      kind: OutboxEventKind
      project: string
      file?: string
      cell?: string
      /** Actor username — populated by post-2c-γ sync workers. */
      by?: string
    }
  | { t: "event.stale"; id: string; reason: string }
  | { t: "presence"; users: PresenceUser[] }
  | { t: "lock.claimed"; cellId: string; by: { userId: string; ts: number } }
  | { t: "lock.released"; cellId: string; by: { userId: string; ts: number } }
  | { t: "project.archived"; project: string; archivedAt?: string; deletedBy?: string }
  /** FRO-346: this user's membership was revoked; the DO closes the socket
   *  (code 4403) right after. `userId` is the presence identity (username). */
  | { t: "member.removed"; project: string; userId: string }
  | {
      t: "link.upstream-changed"
      project: string
      upstream: string
      untilSeq: number
      fileIds: string[]
      cellIds: string[]
    }

/**
 * True when an `event.applied` frame is the echo of a write THIS client just
 * made. The per-project DO broadcasts every winning event back to its origin,
 * but the committing handler already issued a targeted refetch after its
 * outbox flush — so refetching again on the echo just doubles the GET (and the
 * in-flight coalescer can't dedupe it: the handler's refetch is gated behind
 * the flush and lands after this echo's fetch has already cleared). Callers use
 * this to skip the redundant refetch (and to suppress the "remote changed"
 * banner) for their own writes.
 *
 * `by` is only populated by post-2c-γ sync workers. When absent we cannot
 * attribute the write, so we report `false` (treat as remote) — older servers
 * keep their pre-existing "always refetch" behavior rather than risk dropping a
 * real remote change.
 */
export function isOwnWriteEcho(msg: { by?: string }, currentUserId: string): boolean {
  return !!msg.by && msg.by === currentUserId
}

export type ProjectWsClientMessage =
  | { t: "outbox.event"; event: OutboxRawEvent }
  | { t: "focus.claim"; cellId: string; leaseMs?: number }
  | { t: "focus.renew"; cellId: string }
  | { t: "focus.release"; cellId: string }

export interface WsReconcilerHandlers {
  /** Fires for every parsed server frame. */
  onMessage?(msg: ProjectWsServerMessage): void
  /** Fires when the WS reaches OPEN state (after each successful reconnect). */
  onOpen?(): void
  /** Fires on close, before backoff. */
  onClose?(ev: CloseEvent): void
  /** Fires on parse errors or websocket errors. Non-fatal. */
  onError?(err: Error): void
}

export interface WsReconcilerOptions {
  projectId: string
  /** Username / userId for presence messages. Optional — used by ProjectWorkspace. */
  userId?: string
  /**
   * Returns a fresh JWT for the project DO. Called on each connect. Return
   * null when no session — the reconciler stays in the disconnected state
   * and retries when called again.
   */
  getToken(): Promise<string | null>
  /** wss://host or http://host — protocol is normalized. */
  baseUrl: string
  /** Override only for tests. */
  webSocketCtor?: typeof WebSocket
  /** Min backoff between reconnects in ms. */
  minBackoffMs?: number
  /** Max backoff between reconnects in ms. */
  maxBackoffMs?: number
}

export interface WsReconciler {
  /** Currently connected (WebSocket.OPEN). */
  isConnected(): boolean
  /** Send a client message. Returns true iff the WS is OPEN and the frame queued. */
  send(msg: ProjectWsClientMessage): boolean
  /** Force a reconnect; clears the current socket and re-runs the connect path. */
  reconnect(): void
  /** Close + stop reconnecting. */
  close(): void
}

interface WsHostShape {
  Send: typeof WebSocket
  Open: number
}

/**
 * Build the WS URL for a project. `baseUrl` may be http(s); we normalize to
 * ws(s). Path is `/parties/project-sync/<projectId>` to match partyserver's
 * conventional layout, mirroring `parties/file-sync/...`.
 */
export function buildProjectWsUrl(
  baseUrl: string,
  projectId: string,
  token: string | null,
  userId?: string | null,
): string {
  const wsBase = baseUrl
    .replace(/^https?:\/\//, (m) => (m === "https://" ? "wss://" : "ws://"))
    .replace(/\/+$/, "")
  const params: string[] = []
  if (token) params.push(`token=${encodeURIComponent(token)}`)
  // ALLOW_UNAUTHENTICATED dev: the DO ignores the token and reads identity
  // from `?user=`, falling back to "anon". Without this the client connects
  // as "anon" while `currentUsername` is something else, so the client's own
  // presence entry is not filtered out and ends up as a self-held focus lock
  // that blocks commits. Auth mode ignores this param (uses claims.username).
  if (userId) params.push(`user=${encodeURIComponent(userId)}`)
  const suffix = params.length ? `?${params.join("&")}` : ""
  return `${wsBase}/parties/project-sync/${encodeURIComponent(projectId)}${suffix}`
}

/**
 * Create the reconciler. Begins connecting on the next tick — call `close()`
 * to halt. Listeners can be registered before/after connect; messages
 * delivered before the first listener registration are dropped.
 */
export function createWsReconciler(
  options: WsReconcilerOptions,
  handlers: WsReconcilerHandlers = {},
): WsReconciler {
  const minBackoff = options.minBackoffMs ?? 250
  const maxBackoff = options.maxBackoffMs ?? 30_000
  const Ctor =
    options.webSocketCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (!Ctor) {
    throw new Error("createWsReconciler: WebSocket unavailable in this environment")
  }
  const host: WsHostShape = { Send: Ctor, Open: Ctor.OPEN }

  let socket: WebSocket | null = null
  let closed = false
  let backoffMs = minBackoff
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function safeEmit(fn: (() => void) | undefined): void {
    if (!fn) return
    try {
      fn()
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      try {
        handlers.onError?.(e)
      } catch {
        /* swallow */
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed) return
    if (reconnectTimer !== null) return
    const delay = backoffMs
    backoffMs = Math.min(maxBackoff, Math.max(minBackoff, backoffMs * 2))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  async function connect(): Promise<void> {
    if (closed) return
    let token: string | null = null
    try {
      token = await options.getToken()
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      safeEmit(() => handlers.onError?.(e))
      scheduleReconnect()
      return
    }
    if (closed) return
    if (!token) {
      // Don't open a doomed socket — the DO 1008-closes on bad/missing
      // tokens which would just trigger another reconnect immediately.
      // Back off and try again; getToken() will succeed once the JWT race
      // or /sync-token outage resolves.
      scheduleReconnect()
      return
    }

    let ws: WebSocket
    try {
      const url = buildProjectWsUrl(options.baseUrl, options.projectId, token, options.userId)
      ws = new host.Send(url)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      safeEmit(() => handlers.onError?.(e))
      scheduleReconnect()
      return
    }
    socket = ws

    ws.onopen = () => {
      backoffMs = minBackoff
      safeEmit(() => handlers.onOpen?.())
    }
    ws.onmessage = (ev: MessageEvent) => {
      let parsed: ProjectWsServerMessage | null = null
      try {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data)
        parsed = parseProjectWsMessage(raw)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        safeEmit(() => handlers.onError?.(e))
        return
      }
      if (!parsed) {
        safeEmit(() => handlers.onError?.(new Error("ws: unparseable server frame")))
        return
      }
      safeEmit(() => handlers.onMessage?.(parsed))
    }
    ws.onerror = () => {
      // The browser doesn't expose a useful error message on WebSocket.onerror;
      // surface a generic one so callers can count "ws errors" without parsing.
      safeEmit(() => handlers.onError?.(new Error("ws: socket error")))
    }
    ws.onclose = (closeEvent: CloseEvent) => {
      safeEmit(() => handlers.onClose?.(closeEvent))
      socket = null
      scheduleReconnect()
    }
  }

  // Defer the first connect to the next tick so callers can register
  // handlers between createWsReconciler() and the first onOpen.
  queueMicrotask(() => {
    void connect()
  })

  return {
    isConnected(): boolean {
      return socket !== null && socket.readyState === host.Open
    },
    send(msg: ProjectWsClientMessage): boolean {
      if (!socket || socket.readyState !== host.Open) return false
      try {
        socket.send(JSON.stringify(msg))
        return true
      } catch {
        return false
      }
    },
    reconnect(): void {
      if (socket) {
        try {
          socket.close()
        } catch {
          /* swallow */
        }
      }
      backoffMs = minBackoff
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      void connect()
    },
    close(): void {
      closed = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (socket) {
        try {
          socket.close()
        } catch {
          /* swallow */
        }
        socket = null
      }
    },
  }
}

// ── Wire-format helpers ───────────────────────────────────────────────────

/**
 * Defensive parse of an incoming WS frame. Returns null on malformed input
 * (the caller treats this as a parse error and emits onError).
 */
export function parseProjectWsMessage(raw: string): ProjectWsServerMessage | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object") return null
  const m = obj as Record<string, unknown>
  const t = m.t
  if (t === "event.applied") {
    if (
      typeof m.id !== "string" ||
      typeof m.kind !== "string" ||
      typeof m.project !== "string"
    ) {
      return null
    }
    return {
      t: "event.applied",
      id: m.id,
      kind: m.kind as OutboxEventKind,
      project: m.project,
      ...(typeof m.file === "string" ? { file: m.file } : {}),
      ...(typeof m.cell === "string" ? { cell: m.cell } : {}),
      ...(typeof m.by === "string" ? { by: m.by } : {}),
    }
  }
  if (t === "event.stale") {
    if (typeof m.id !== "string" || typeof m.reason !== "string") return null
    return { t: "event.stale", id: m.id, reason: m.reason }
  }
  if (t === "presence") {
    if (!Array.isArray(m.users)) return null
    const users: PresenceUser[] = []
    for (const u of m.users) {
      if (!u || typeof u !== "object") return null
      const r = u as Record<string, unknown>
      if (typeof r.userId !== "string" || typeof r.ts !== "number") return null
      users.push({
        userId: r.userId,
        ts: r.ts,
        ...(typeof r.focusedCell === "string" ? { focusedCell: r.focusedCell } : {}),
      })
    }
    return { t: "presence", users }
  }
  if (t === "lock.claimed" || t === "lock.released") {
    if (typeof m.cellId !== "string" || !m.by || typeof m.by !== "object") return null
    const b = m.by as Record<string, unknown>
    if (typeof b.userId !== "string" || typeof b.ts !== "number") return null
    return {
      t,
      cellId: m.cellId,
      by: { userId: b.userId, ts: b.ts },
    }
  }
  if (t === "member.removed") {
    // FRO-346: the DO sends this to a removed member's sockets right before
    // closing them; the workspace re-fetches the project (which now 403s)
    // and lands on the "you no longer have access" state.
    if (typeof m.project !== "string" || typeof m.userId !== "string") return null
    return { t: "member.removed", project: m.project, userId: m.userId }
  }
  if (t === "link.upstream-changed") {
    if (
      typeof m.project !== "string" ||
      typeof m.upstream !== "string" ||
      typeof m.untilSeq !== "number" ||
      !Array.isArray(m.fileIds) ||
      !Array.isArray(m.cellIds)
    ) {
      return null
    }
    return {
      t: "link.upstream-changed",
      project: m.project,
      upstream: m.upstream,
      untilSeq: m.untilSeq,
      fileIds: m.fileIds.filter((f): f is string => typeof f === "string"),
      cellIds: m.cellIds.filter((c): c is string => typeof c === "string"),
    }
  }
  return null
}

// ── FRO-479 push-accelerator client glue ──────────────────────────────────
//
// FRO-479 wiring (done by the swarm orchestrator): ProjectWorkspace.tsx builds
// `createLinkUpstreamChangedHandler` once per WS connect (revalidate routed
// through a ref so the once-created onMessage closure always reaches the
// latest useStaleSourceCells.revalidate, which piggybacks POST /link/sync)
// and dispatches `link.upstream-changed` frames to it in onMessage.
// SWARM-TODO(FRO-479) [live-UI verify]: open upstream project A and its live
// downstream B in two browser windows, edit+commit a source cell in A, and
// confirm B's stale badge + cell text update within a few seconds, no reload.

export interface LinkUpstreamChangedHandlerOptions {
  /** Returns the currently open project id, or null if none/not loaded yet.
   *  Frames for any other project are ignored (a stale reconciler from a
   *  just-closed project, or — defensively — a server bug). */
  currentProjectId(): string | null
  /** Triggers a refetch of stale-source state (`useStaleSourceCells.revalidate`). */
  revalidateStaleSource(): void
  /** Fire-and-forget POST /link/sync for the currently open project/file —
   *  same shape as `useStaleSourceCells.ts`'s existing `triggerLinkSync`. */
  triggerLinkSync(): void
  /** Debounce window — bursts of frames (e.g. a large upstream re-import)
   *  collapse to one sync per project per window (spec: "one sync per 5s
   *  per project so bursts don't hammer the route"). */
  debounceMs?: number
  /** Injectable clock for tests. */
  now?(): number
}

const LINK_UPSTREAM_CHANGED_DEFAULT_DEBOUNCE_MS = 5000

/**
 * Build a handler for `link.upstream-changed` frames. Always calls
 * `revalidateStaleSource()` immediately (cheap — a GET, and staleness must
 * reflect the frame as soon as possible), but debounces `triggerLinkSync()`
 * per the options window so a burst of upstream commits (e.g. a large
 * re-import) collapses to one `/link/sync` POST instead of hammering the
 * route once per frame.
 *
 * Pure with respect to time: pass `now` in tests to avoid fake timers.
 */
export function createLinkUpstreamChangedHandler(
  options: LinkUpstreamChangedHandlerOptions,
): (msg: Extract<ProjectWsServerMessage, { t: "link.upstream-changed" }>) => void {
  const debounceMs = options.debounceMs ?? LINK_UPSTREAM_CHANGED_DEFAULT_DEBOUNCE_MS
  const now = options.now ?? (() => Date.now())
  // -Infinity, not 0: with an injected `now: () => t` starting at t=0 (as
  // tests do), a `lastSyncAt` of 0 would suppress the very first call.
  let lastSyncAt = -Infinity

  return (msg) => {
    const pid = options.currentProjectId()
    if (!pid || msg.project !== pid) return

    // Staleness must reflect the frame immediately — cheap GET, no debounce.
    options.revalidateStaleSource()

    const t = now()
    if (t - lastSyncAt < debounceMs) return
    lastSyncAt = t
    options.triggerLinkSync()
  }
}
