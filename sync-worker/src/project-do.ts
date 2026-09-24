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
import { shouldBeReadOnly, verifyTokenForProject } from "./auth"
import { isDeployedEnvironment } from "./environment-guard"
import {
  applyDisconnect,
  applyFocusClaim,
  applyFocusRelease,
  applyFocusRenew,
  applyPresenceUpdate,
  parseProjectDoClientMessage,
  PresenceDraftThrottle,
  presenceFrameOwnerConnId,
  presenceSnapshot,
  PROJECT_DO_DEFAULT_LEASE_MS,
  resolveConnId,
  stripPresenceDraft,
  sweepExpiredLeases,
  unpackBroadcastBody,
  type LockState,
  type PresenceState,
  type ProjectDoServerMessage,
} from "./project-do-handlers"
import type { OutboxRawEvent } from "./project-do-types"
import { mondayNotifyProject, notifyMondayProgress } from "./monday-notify"
import { mirrorSync, type MirrorSyncResult } from "./events/link-sync"
import { makePostgres } from "../../db/shim/postgres"
import { serviceBearerMatches } from "./lib/service-auth"

const LEASE_SWEEP_INTERVAL_MS = 5_000

/**
 * AQU-346: how long a member-removed denylist entry blocks reconnects.
 * Must exceed the sync-token TTL (15 min, auth-worker SYNC_TOKEN_TTL_SECONDS)
 * so a removed user's cached-but-still-valid token cannot rejoin; after this
 * window every token minted before the removal has expired and the mint-time
 * gate (auth-worker resolveProjectRole) is the authority again. In-memory
 * only — DO eviction clears it, which is safe for the same TTL reason.
 */
const MEMBER_REMOVED_DENY_MS = 16 * 60 * 1000

/** App-specific WS close code for "your membership was revoked". */
export const MEMBER_REMOVED_CLOSE_CODE = 4403

/**
 * [Pen test 2026-08-24] App-specific WS close code for "your sync token
 * expired". A connection's `role` is cached at handshake time and never
 * re-checked for the socket's lifetime — a mid-session role downgrade (short
 * of full removal, which /__member-removed already handles) previously had
 * no path to take effect until the client happened to reconnect on its own.
 * Forcing a close at the token's own expiry (≤ SYNC_TOKEN_TTL_SECONDS) bounds
 * that staleness window and makes the reconnect fetch a fresh token/role via
 * ws-reconciler's connect(), which already re-authenticates from scratch.
 */
export const TOKEN_EXPIRED_CLOSE_CODE = 4401

interface ConnectionState {
  ws: WebSocket
  /**
   * Per-socket presence key. Sent by the client as `?connId=` (generated per
   * socket session in ws-reconciler.ts); older clients omit it and get a
   * server-generated id — they still work, they just can't self-filter by it.
   */
  connId: string
  userId: string
  /** Numeric user id from verified token claims; null in ALLOW_UNAUTHENTICATED dev. */
  numericUserId: number | null
  /**
   * Role level from verified token claims; null in ALLOW_UNAUTHENTICATED dev
   * (treated permissively, matching shouldBeReadOnly's null-role default).
   * [Pen test 2026-08-10] previously unused — focus.claim/renew accepted
   * any authenticated connection regardless of role, letting a Viewer or
   * Commenter hold every cell's edit lock and lock out Contributors.
   */
  role: number | null
  /**
   * [Pen test 2026-08-24] Verified token's `exp` claim in epoch ms; null in
   * ALLOW_UNAUTHENTICATED dev (no token to expire). The lease sweep closes
   * the socket once this passes, forcing a reconnect with a fresh token.
   */
  tokenExpiresAt: number | null
}

interface DOEnv {
  SYNC_SECRET_KEY?: string
  ALLOW_UNAUTHENTICATED?: string
  /**
   * Deployment label ("production" | "development" | "local" | unset). Read
   * here only so the ALLOW_UNAUTHENTICATED bypass can be refused on deployed
   * workers — see isDeployedEnvironment.
   */
  ENVIRONMENT?: string
  /**
   * Optional binding back to the worker so we can POST to /events via an
   * internal fetch. When absent (tests), outbox.event frames are queued
   * but not forwarded.
   */
  SELF?: { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
  /**
   * AQU-476: Hyperdrive binding for the mirror sync engine (/__link-sync).
   * Unlike the worker's top-level fetch, a DO instance does NOT receive the
   * request-scoped synthesized AQUILLA_PG — it gets its own env from the
   * Workers runtime bindings, so /__link-sync builds its own short-lived
   * Postgres connection from HYPERDRIVE, same as index.ts does.
   */
  HYPERDRIVE?: { connectionString: string }
  /** Test seam: inject a fake AquillaDb directly, bypassing HYPERDRIVE. */
  AQUILLA_PG?: AquillaDb
  /** Identity worker base URL for the Monday integration push nudge
   *  (monday-notify.ts). Absent → the nudge is a no-op. */
  AUTH_WORKER_URL?: string
}

/** Min gap between Monday push nudges per DO instance. Identity debounces and
 *  dirty-flags on its side too; this only caps subrequest chatter. */
const MONDAY_NOTIFY_THROTTLE_MS = 60_000

export class ProjectSync extends DurableObject<DOEnv> {
  private connections = new Map<WebSocket, ConnectionState>()
  private presence = new Map<string, PresenceState>()
  private locks = new Map<string, LockState>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** Per-user rate limit for `presence.draft` frames (in-memory, like all DO state). */
  private draftThrottle = new PresenceDraftThrottle((frame) => this.broadcast(frame))
  /**
   * AQU-346: numeric userIds whose membership was revoked, mapped to the
   * deny-until timestamp. Blocks reconnects with still-valid (≤15 min)
   * tokens after an eject. In-memory by design (no durable DO state).
   */
  private removedUsers = new Map<number, number>()
  /**
   * AQU-476: single-flight for the mirror sync. One DO instance == one
   * project, so a single in-flight promise field serializes concurrent
   * /__link-sync callers (push accelerator + lazy pull racing) — the second
   * caller awaits the SAME run instead of starting an overlapping fold. This
   * is what the design spec's "serialized single-flight per downstream
   * through the ProjectSync DO" means concretely.
   */
  private linkSyncInFlight: Promise<MirrorSyncResult> | null = null
  /** Monday push nudge throttle (in-memory; eviction resets it, which is fine —
   *  identity's cron reconciliation covers gaps). */
  private lastMondayNotifyAt = 0

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // AQU-476: mirror sync trigger, single-flighted per DO instance (see
    // linkSyncInFlight above). Internal-only, same bearer-secret gate as
    // /__broadcast. `?project=` is required (the DO doesn't trust
    // `idFromName`'s internal id string as the project id) — same query-
    // param convention as /connect, so the caller (link-sync-route.ts)
    // passes it explicitly.
    //
    // SWARM-TODO(AQU-476): verify single-flight against a REAL deployed DO
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
      if (!serviceBearerMatches(request.headers.get("Authorization"), this.env)) {
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
        console.error("[project-do] mirror sync failed:", err)
        return new Response("mirror sync failed", { status: 500 })
      }
    }

    // Internal broadcast hook (POST /events fans out to us here). Pre-built
    // ServerMessage; we forward to every connection.
    if (request.method === "POST" && url.pathname === "/__broadcast") {
      if (!serviceBearerMatches(request.headers.get("Authorization"), this.env)) {
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
      const frames = unpackBroadcastBody(body)
      for (const msg of frames) {
        this.broadcastToAll(msg)
      }
      // Monday integration nudge: content frames imply progress may have
      // changed. Throttled + best-effort; never blocks the broadcast reply.
      const mondayProject = mondayNotifyProject(frames)
      if (mondayProject && Date.now() - this.lastMondayNotifyAt > MONDAY_NOTIFY_THROTTLE_MS) {
        this.lastMondayNotifyAt = Date.now()
        this.ctx.waitUntil(notifyMondayProgress(this.env, mondayProject))
      }
      return Response.json({ ok: true, recipients: this.connections.size })
    }

    // AQU-346: membership-revocation hook. identity's member-removal routes
    // notify the sync-worker, which forwards here (see member-removed.ts).
    // We eject the user's live sockets (member.removed frame + 4403 close)
    // and denylist the numeric userId for longer than the token TTL so a
    // cached still-valid token can't just reconnect.
    if (request.method === "POST" && url.pathname === "/__member-removed") {
      if (!serviceBearerMatches(request.headers.get("Authorization"), this.env)) {
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

    // [Pen test 2026-08-17] role-change hook, companion to /__member-removed
    // above. A live connection's role is captured once at /connect (see
    // ConnectionState) and gates focus.claim/focus.renew — without this, a
    // demotion (e.g. contributor -> viewer) doesn't take effect until the
    // socket reconnects, letting an already-connected demoted user keep
    // holding/renewing the edit lock. Updates the cached role in place;
    // deliberately does NOT close the socket (an ordinary role change,
    // including promotions, isn't itself a reason to force a reconnect).
    if (request.method === "POST" && url.pathname === "/__member-role-changed") {
      if (!serviceBearerMatches(request.headers.get("Authorization"), this.env)) {
        return new Response("unauthorized", { status: 401 })
      }
      let body: { project?: string; userId?: number; username?: string; role?: number }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return new Response("bad request", { status: 400 })
      }
      if (typeof body.userId !== "number" || typeof body.role !== "number") {
        return new Response("userId (number) and role (number) required", { status: 400 })
      }
      let updated = 0
      for (const conn of this.connections.values()) {
        const matches =
          conn.numericUserId === body.userId ||
          (body.username != null && conn.userId === body.username)
        if (!matches) continue
        conn.role = body.role
        updated++
      }
      return Response.json({ ok: true, updated })
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
    //
    // The bypass is honoured only off a deployed worker. index.ts already
    // 503s the whole worker when the flag is set in a deployed environment,
    // but the authorization decision lives here, so it re-checks rather than
    // inheriting the entry point's answer.
    const bypassAuth =
      this.env.ALLOW_UNAUTHENTICATED === "true" && !isDeployedEnvironment(this.env)
    let userId: string
    let numericUserId: number | null = null
    let role: number | null = null
    let tokenExpiresAt: number | null = null
    if (!bypassAuth) {
      const token = url.searchParams.get("token")
      const auth = await verifyTokenForProject(token, projectId, this.env.SYNC_SECRET_KEY)
      if (!auth.ok) {
        return new Response(auth.reason, { status: auth.status })
      }
      // AQU-346: a valid token only proves membership at MINT time. If this
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
      role = auth.claims.role
      tokenExpiresAt = auth.claims.exp * 1000
    } else {
      userId = url.searchParams.get("user") ?? "anon"
    }

    const connId = resolveConnId(url.searchParams.get("connId"), this.connections)

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()

    const conn: ConnectionState = { ws: server, connId, userId, numericUserId, role, tokenExpiresAt }
    this.connections.set(server, conn)
    const joined: PresenceState = { connId, userId, ts: Date.now() }
    this.presence.set(connId, joined)
    this.startLeaseSweep()
    // Snapshot of current roster (drafts stripped) so the new client sees
    // existing peers; everyone else learns about the newcomer via a diff.
    this.sendTo(server, presenceSnapshot(this.presence))
    this.broadcast({ t: "presence.diff", user: stripPresenceDraft(joined) })

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

  private broadcastToAll(msg: ProjectDoServerMessage, exceptConnId?: string): void {
    const payload = JSON.stringify(msg)
    for (const [ws, conn] of this.connections) {
      if (exceptConnId !== undefined && conn.connId === exceptConnId) continue
      try {
        ws.send(payload)
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * AQU-1162: broadcast, but never echo a presence frame back to the socket it
   * describes. A typing client publishes presence roughly every 650ms and
   * moves the cursor every ~120ms; each echo costs that same client a socket
   * frame, a parse, a presence-store apply and a `ProjectWorkspace` shell pass
   * — for a row every consumer then filters out as its own (`isSelfRow` in the
   * presence store, the `currentUsername` check in `applyPresenceFrame`).
   * Non-presence frames (locks, content, project events) are unaffected: the
   * originator does act on those.
   */
  private broadcast(msg: ProjectDoServerMessage): void {
    this.broadcastToAll(msg, presenceFrameOwnerConnId(msg))
  }

  // ── Inbound handling ───────────────────────────────────────────────────

  private handleClientMessage(conn: ConnectionState, raw: string): void {
    const msg = parseProjectDoClientMessage(raw)
    if (!msg) return
    const now = Date.now()
    if (msg.t === "focus.claim") {
      // [Pen test 2026-08-10] a read-only role (viewer/commenter/reviewer)
      // can observe and render the editor but must not be able to hold an
      // edit lock — granting one anyway lets them block every contributor
      // out of a cell indefinitely. Mirrors the write-drop policy already
      // applied to actual content writes (see shouldBeReadOnly callers).
      if (shouldBeReadOnly(conn.role)) return
      const result = applyFocusClaim(this.locks, this.presence, conn, msg, now)
      this.locks = result.locks
      this.presence = result.presence
      for (const m of result.emit) this.broadcast(m)
      for (const m of result.emitTo) this.sendTo(conn.ws, m)
      return
    }
    if (msg.t === "focus.renew") {
      if (shouldBeReadOnly(conn.role)) return
      const result = applyFocusRenew(this.locks, this.presence, conn, msg, now)
      this.locks = result.locks
      return
    }
    if (msg.t === "focus.release") {
      const result = applyFocusRelease(this.locks, this.presence, conn, msg, now)
      this.locks = result.locks
      this.presence = result.presence
      for (const m of result.emit) this.broadcast(m)
      return
    }
    if (msg.t === "presence.update") {
      const result = applyPresenceUpdate(this.presence, conn, msg, now)
      this.presence = result.presence
      for (const m of result.emit) {
        if (m.t === "presence.draft") this.draftThrottle.push(m)
        else this.broadcast(m)
      }
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
    // Idempotency guard: the AQU-346 eject path calls this explicitly right
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
    const result = applyDisconnect(this.locks, this.presence, conn, now, remaining)
    this.locks = result.locks
    this.presence = result.presence
    this.draftThrottle.clear(conn.connId)
    for (const m of result.emit) this.broadcast(m)
    if (this.connections.size === 0) this.stopLeaseSweep()
  }

  private startLeaseSweep(): void {
    if (this.sweepTimer !== null) return
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      const result = sweepExpiredLeases(this.locks, this.presence, now)
      this.locks = result.locks
      this.presence = result.presence
      for (const m of result.emit) this.broadcast(m)
      this.sweepExpiredConnections(now)
    }, LEASE_SWEEP_INTERVAL_MS)
  }

  /**
   * [Pen test 2026-08-24] A connection's role is resolved once at handshake
   * and cached for the socket's life (see ConnectionState.role) — closing at
   * the token's own expiry re-runs that resolution on reconnect instead of
   * letting a stale role (e.g. after a mid-session downgrade) ride an
   * indefinitely-open socket. Bounded by LEASE_SWEEP_INTERVAL_MS, well under
   * the sync-token TTL.
   */
  private sweepExpiredConnections(now: number): void {
    for (const [ws, conn] of [...this.connections]) {
      if (conn.tokenExpiresAt === null || conn.tokenExpiresAt > now) continue
      try {
        ws.close(TOKEN_EXPIRED_CLOSE_CODE, "sync token expired")
      } catch {
        /* swallow */
      }
      // Server-initiated close doesn't reliably fire our own close listener —
      // clean up presence/locks explicitly (idempotent; see the
      // connections.has guard in handleConnectionClose).
      this.handleConnectionClose(conn)
    }
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
