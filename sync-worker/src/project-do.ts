/**
 * Per-project Durable Object — AD-1 live coordination.
 *
 * One DO instance per project. Holds **only transient state**:
 *   - Connected clients' presence (who's on which cell)
 *   - Focus-lock leases (per cell, with auto-expiry)
 *   - A relay channel for `event.applied` / `event.stale` frames coming
 *     from POST /events broadcasts (cross-DO via the standard
 *     SYNC_SECRET_KEY-gated __broadcast hook).
 *
 * No durable state is written to DO storage — when the room empties, the
 * DO is allowed to evict naturally. Matches AD-1 / data-model lifecycle:
 * "discarded when no clients are connected".
 *
 * The bulk of the logic lives in `project-do-handlers.ts` as pure
 * functions (testable without a DO host); this class is the WebSocket
 * lifecycle wrapper.
 */

import { DurableObject } from "cloudflare:workers"
import { verifyTokenForProject } from "./auth"
import {
  applyDisconnect,
  applyFocusClaim,
  applyFocusRelease,
  applyFocusRenew,
  parseProjectDoClientMessage,
  PROJECT_DO_DEFAULT_LEASE_MS,
  sweepExpiredLeases,
  unpackBroadcastBody,
  type LockState,
  type PresenceState,
  type ProjectDoServerMessage,
} from "./project-do-handlers"
import type { OutboxRawEvent } from "./project-do-types"

const LEASE_SWEEP_INTERVAL_MS = 5_000

interface ConnectionState {
  ws: WebSocket
  userId: string
}

interface DOEnv {
  SYNC_SECRET_KEY?: string
  ALLOW_UNAUTHENTICATED?: string
  /**
   * Optional binding back to the worker so we can POST to /events via an
   * internal fetch. When absent (tests), outbox.event frames are queued
   * but not forwarded.
   */
  SELF?: { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
}

export class ProjectSync extends DurableObject<DOEnv> {
  private connections = new Map<WebSocket, ConnectionState>()
  private presence = new Map<string, PresenceState>()
  private locks = new Map<string, LockState>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Internal broadcast hook (POST /events fans out to us here). Pre-built
    // ServerMessage; we forward to every connection.
    if (request.method === "POST" && url.pathname === "/__broadcast") {
      const auth = request.headers.get("Authorization") ?? ""
      const expected = this.env.SYNC_SECRET_KEY
        ? `Bearer ${this.env.SYNC_SECRET_KEY}`
        : null
      if (!expected || auth !== expected) {
        return new Response("unauthorized", { status: 401 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response("bad request", { status: 400 })
      }
      // PERF-8: the body is either a single ServerMessage (legacy callers,
      // e.g. archive-broadcast) or a broadcast.batch envelope carrying all
      // of a project's frames for one POST /events request. Clients receive
      // one WS frame per message either way.
      for (const msg of unpackBroadcastBody(body)) {
        this.broadcastToAll(msg)
      }
      return Response.json({ ok: true, recipients: this.connections.size })
    }

    if (url.pathname !== "/connect") {
      return new Response("not found", { status: 404 })
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 })
    }

    const projectId = url.searchParams.get("project")
    if (!projectId) {
      return new Response("missing project", { status: 400 })
    }

    // Identity comes from the verified token, not a client query param: the
    // connect URL only carries `?token=` (see buildProjectWsUrl), so reading a
    // `user` param here always yielded null → 400, breaking every WS handshake
    // and pinning the client in a reconnect loop. The sync-token stamps the
    // Frontier username (claims.username), which matches the `currentUsername`
    // the client uses for presence/lock filtering. ALLOW_UNAUTHENTICATED dev
    // has no token, so fall back to the optional `user` param or "anon".
    let userId: string
    if (this.env.ALLOW_UNAUTHENTICATED !== "true") {
      const token = url.searchParams.get("token")
      const auth = await verifyTokenForProject(token, projectId, this.env.SYNC_SECRET_KEY)
      if (!auth.ok) {
        return new Response(auth.reason, { status: auth.status })
      }
      userId = auth.claims.username ?? `user:${auth.claims.userId}`
    } else {
      userId = url.searchParams.get("user") ?? "anon"
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()

    const conn: ConnectionState = { ws: server, userId }
    this.connections.set(server, conn)
    this.presence.set(userId, { userId, ts: Date.now() })
    this.startLeaseSweep()
    // Snapshot of current roster so the new client sees existing peers.
    this.sendTo(server, {
      t: "presence",
      users: Array.from(this.presence.values()),
    })
    this.broadcastPresence()

    server.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : ""
      this.handleClientMessage(conn, raw)
    })
    server.addEventListener("close", () => this.handleConnectionClose(conn))
    server.addEventListener("error", () => this.handleConnectionClose(conn))

    return new Response(null, { status: 101, webSocket: client })
  }

  // ── Outbound helpers ───────────────────────────────────────────────────

  private sendTo(ws: WebSocket, msg: ProjectDoServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      /* swallow */
    }
  }

  private broadcastToAll(msg: ProjectDoServerMessage): void {
    const payload = JSON.stringify(msg)
    for (const ws of this.connections.keys()) {
      try {
        ws.send(payload)
      } catch {
        /* swallow */
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcastToAll({
      t: "presence",
      users: Array.from(this.presence.values()),
    })
  }

  // ── Inbound handling ───────────────────────────────────────────────────

  private handleClientMessage(conn: ConnectionState, raw: string): void {
    const msg = parseProjectDoClientMessage(raw)
    if (!msg) return
    const now = Date.now()
    if (msg.t === "focus.claim") {
      const result = applyFocusClaim(this.locks, this.presence, conn.userId, msg, now)
      this.locks = result.locks
      this.presence = result.presence
      for (const m of result.emit) this.broadcastToAll(m)
      for (const m of result.emitTo) this.sendTo(conn.ws, m)
      return
    }
    if (msg.t === "focus.renew") {
      const result = applyFocusRenew(this.locks, this.presence, conn.userId, msg, now)
      this.locks = result.locks
      return
    }
    if (msg.t === "focus.release") {
      const result = applyFocusRelease(this.locks, this.presence, conn.userId, msg, now)
      this.locks = result.locks
      this.presence = result.presence
      for (const m of result.emit) this.broadcastToAll(m)
      return
    }
    if (msg.t === "outbox.event") {
      void this.forwardOutboxEvent(msg.event)
      return
    }
  }

  private async forwardOutboxEvent(event: OutboxRawEvent): Promise<void> {
    // Phase 2c-α: the WS-based outbox path is wire-defined but the round-
    // trip from DO to POST /events isn't wired yet — the events route
    // re-authorizes via the bearer JWT which the DO doesn't carry through.
    // Until that path lands, clients fall back to the existing HTTP outbox
    // (useOutboxFlusher) on the same JWT. Logging only here so the path is
    // observable in worker logs.
    console.log(`[ProjectSync] outbox.event passthrough (no-op)`, event.id)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  private handleConnectionClose(conn: ConnectionState): void {
    this.connections.delete(conn.ws)
    // Count remaining connections for this user AFTER removing the closing one.
    // applyDisconnect uses this to decide whether to release per-user locks/presence:
    // if other tabs are still connected, leave them intact (RACE-6).
    let remaining = 0
    for (const state of this.connections.values()) {
      if (state.userId === conn.userId) remaining++
    }
    const now = Date.now()
    const result = applyDisconnect(this.locks, this.presence, conn.userId, now, remaining)
    this.locks = result.locks
    this.presence = result.presence
    for (const m of result.emit) this.broadcastToAll(m)
    if (this.connections.size === 0) this.stopLeaseSweep()
  }

  private startLeaseSweep(): void {
    if (this.sweepTimer !== null) return
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      const result = sweepExpiredLeases(this.locks, now)
      this.locks = result.locks
      for (const m of result.emit) this.broadcastToAll(m)
      if (result.emit.length > 0) this.broadcastPresence()
    }, LEASE_SWEEP_INTERVAL_MS)
  }

  private stopLeaseSweep(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  // ── Test seams ─────────────────────────────────────────────────────────

  /** @internal */
  __testBroadcast(msg: ProjectDoServerMessage): void {
    this.broadcastToAll(msg)
  }
  /** @internal */
  __testGetLocks(): ReadonlyMap<string, LockState> {
    return this.locks
  }
}

/** Unused suppression — we keep the default for the lease in case future
 *  code wants to surface it. */
export { PROJECT_DO_DEFAULT_LEASE_MS as PROJECT_DO_DEFAULT_LEASE }
