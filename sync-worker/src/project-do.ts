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
  applyPresenceUpdate,
  parseProjectDoClientMessage,
  PROJECT_DO_DEFAULT_LEASE_MS,
  sweepExpiredLeases,
  unpackBroadcastBody,
  type LockState,
  type PresenceState,
  type ProjectDoServerMessage,
} from "./project-do-handlers"
import type { OutboxRawEvent } from "./project-do-types"
import { mirrorSync, type MirrorSyncResult } from "./events/link-sync"
import { makePostgres } from "../../db/shim/postgres"

const LEASE_SWEEP_INTERVAL_MS = 5_000

/**
 * FRO-346: how long a member-removed denylist entry blocks reconnects.
 * Must exceed the sync-token TTL (15 min, auth-worker SYNC_TOKEN_TTL_SECONDS)
 * so a removed user's cached-but-still-valid token cannot rejoin; after this
 * window every token minted before the removal has expired and the mint-time
 * gate (auth-worker resolveProjectRole) is the authority again. In-memory
 * only — DO eviction clears it, which is safe for the same TTL reason.
 */
const MEMBER_REMOVED_DENY_MS = 16 * 60 * 1000

/** App-specific WS close code for "your membership was revoked". */
export const MEMBER_REMOVED_CLOSE_CODE = 4403

interface ConnectionState {
  ws: WebSocket
  userId: string
  /** Numeric user id from verified token claims; null in ALLOW_UNAUTHENTICATED dev. */
  numericUserId: number | null
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
  /**
   * FRO-476: Hyperdrive binding for the mirror sync engine (/__link-sync).
   * Unlike the worker's top-level fetch, a DO instance does NOT receive the
   * request-scoped synthesized AQUILLA_PG — it gets its own env from the
   * Workers runtime bindings, so /__link-sync builds its own short-lived
   * Postgres connection from HYPERDRIVE, same as index.ts does.
   */
  HYPERDRIVE?: { connectionString: string }
  /** Test seam: inject a fake AquillaDb directly, bypassing HYPERDRIVE. */
  AQUILLA_PG?: AquillaDb
}

export class ProjectSync extends DurableObject<DOEnv> {
  private connections = new Map<WebSocket, ConnectionState>()
  private presence = new Map<string, PresenceState>()
  private locks = new Map<string, LockState>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /**
   * FRO-346: numeric userIds whose membership was revoked, mapped to the
   * deny-until timestamp. Blocks reconnects with still-valid (≤15 min)
   * tokens after an eject. In-memory by design (no durable DO state).
   */
  private removedUsers = new Map<number, number>()
  /**
   * FRO-476: single-flight for the mirror sync. One DO instance == one
   * project, so a single in-flight promise field serializes concurrent
   * /__link-sync callers (push accelerator + lazy pull racing) — the second
   * caller awaits the SAME run instead of starting an overlapping fold. This
   * is what the design spec's "serialized single-flight per downstream
   * through the ProjectSync DO" means concretely.
   */
  private linkSyncInFlight: Promise<MirrorSyncResult> | null = null

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // FRO-476: mirror sync trigger, single-flighted per DO instance (see
    // linkSyncInFlight above). Internal-only, same bearer-secret gate as
    // /__broadcast. `?project=` is required (the DO doesn't trust
    // `idFromName`'s internal id string as the project id) — same query-
    // param convention as /connect, so the caller (link-sync-route.ts)
    // passes it explicitly.
    //
    // SWARM-TODO(FRO-476): verify single-flight against a REAL deployed DO
    // (vitest can't exercise Cloudflare's actual DO runtime/HYPERDRIVE
    // binding — the unit tests call mirrorSync() directly and the route
    // tests stub AQUILLA_PG). On the dev stack: create project A (import a
    // small USFM), create project B via
    //   curl -X POST https://<auth>/api/v2/projects/B/link-source \
    //     -d '{"sourceProjectId":"A","mode":"live"}'
    // then fire two overlapping
    //   curl -X POST https://<sync>/api/v1/projects/B/link/sync
    // calls (e.g. via `xargs -P2`) and confirm via server logs / a DB read
    // that only one fold ran (the second awaited the first's in-flight
    // promise) and B's cells match A's head afterward.
    if (request.method === "POST" && url.pathname === "/__link-sync") {
      const auth = request.headers.get("Authorization") ?? ""
      const expected = this.env.SYNC_SECRET_KEY ? `Bearer ${this.env.SYNC_SECRET_KEY}` : null
      if (!expected || auth !== expected) {
        return new Response("unauthorized", { status: 401 })
      }
      const projectId = url.searchParams.get("project")
      if (!projectId) {
        return new Response("missing project query param", { status: 400 })
      }
      // Test seam takes priority; otherwise build a short-lived PG connection
      // from HYPERDRIVE (this DO instance's own env, not the request-scoped
      // synthesized AQUILLA_PG the worker's top-level fetch uses).
      const db = this.env.AQUILLA_PG ?? (this.env.HYPERDRIVE && makePostgres(this.env.HYPERDRIVE.connectionString))
      if (!db) {
        return new Response("HYPERDRIVE binding not configured", { status: 500 })
      }
      if (!this.linkSyncInFlight) {
        this.linkSyncInFlight = mirrorSync(db as AquillaDb, projectId).finally(() => {
          this.linkSyncInFlight = null
          if (!this.env.AQUILLA_PG) void (db as { close(): Promise<void> }).close?.()
        })
      }
      try {
        const result = await this.linkSyncInFlight
        return Response.json(result)
      } catch (err) {
        return new Response(`mirror sync failed: ${String(err)}`, { status: 500 })
      }
    }

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

    // FRO-346: membership-revocation hook. identity's member-removal routes
    // notify the sync-worker, which forwards here (see member-removed.ts).
    // We eject the user's live sockets (member.removed frame + 4403 close)
    // and denylist the numeric userId for longer than the token TTL so a
    // cached still-valid token can't just reconnect.
    if (request.method === "POST" && url.pathname === "/__member-removed") {
      const auth = request.headers.get("Authorization") ?? ""
      const expected = this.env.SYNC_SECRET_KEY
        ? `Bearer ${this.env.SYNC_SECRET_KEY}`
        : null
      if (!expected || auth !== expected) {
        return new Response("unauthorized", { status: 401 })
      }
      let body: { project?: string; userId?: number; username?: string }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return new Response("bad request", { status: 400 })
      }
      if (typeof body.userId !== "number" || typeof body.project !== "string") {
        return new Response("userId (number) and project (string) required", { status: 400 })
      }
      this.removedUsers.set(body.userId, Date.now() + MEMBER_REMOVED_DENY_MS)
      let ejected = 0
      for (const [ws, conn] of [...this.connections]) {
        const matches =
          conn.numericUserId === body.userId ||
          (body.username != null && conn.userId === body.username)
        if (!matches) continue
        this.sendTo(ws, { t: "member.removed", project: body.project, userId: conn.userId })
        try {
          ws.close(MEMBER_REMOVED_CLOSE_CODE, "membership revoked")
        } catch {
          /* swallow */
        }
        // Server-initiated close doesn't reliably fire our own close
        // listener — clean up presence/locks explicitly (idempotent; see
        // the connections.has guard in handleConnectionClose).
        this.handleConnectionClose(conn)
        ejected++
      }
      return Response.json({ ok: true, ejected })
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
    let numericUserId: number | null = null
    if (this.env.ALLOW_UNAUTHENTICATED !== "true") {
      const token = url.searchParams.get("token")
      const auth = await verifyTokenForProject(token, projectId, this.env.SYNC_SECRET_KEY)
      if (!auth.ok) {
        return new Response(auth.reason, { status: auth.status })
      }
      // FRO-346: a valid token only proves membership at MINT time. If this
      // user was ejected via /__member-removed, refuse reconnects until every
      // token minted before the removal has expired (deny window > token TTL).
      const deniedUntil = this.removedUsers.get(auth.claims.userId)
      if (deniedUntil != null) {
        if (deniedUntil > Date.now()) {
          return new Response("membership revoked", { status: 403 })
        }
        this.removedUsers.delete(auth.claims.userId)
      }
      userId = auth.claims.username ?? `user:${auth.claims.userId}`
      numericUserId = auth.claims.userId
    } else {
      userId = url.searchParams.get("user") ?? "anon"
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()

    const conn: ConnectionState = { ws: server, userId, numericUserId }
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
    if (msg.t === "presence.update") {
      const result = applyPresenceUpdate(this.presence, conn.userId, msg, now)
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
    // Idempotency guard: the FRO-346 eject path calls this explicitly right
    // after ws.close(); if the runtime later fires the close event anyway,
    // the second invocation must not re-run applyDisconnect.
    if (!this.connections.has(conn.ws)) return
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
      const result = sweepExpiredLeases(this.locks, this.presence, now)
      this.locks = result.locks
      this.presence = result.presence
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
