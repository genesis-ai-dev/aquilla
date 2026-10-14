/**
 * Per-project Durable Object — AD-1 live coordination.
 *
 * One DO instance per project. Holds the live coordination state:
 *   - Connected clients' presence (who's on which cell)
 *   - Focus-lock leases (per cell, with auto-expiry)
 *   - A relay channel for `event.applied` / `event.stale` frames coming
 *     from POST /events broadcasts (cross-DO via the standard
 *     SYNC_SECRET_KEY-gated __broadcast hook).
 *
 * AQU-1836: sockets are accepted through the **WebSocket Hibernation API**,
 * so between frames the DO is evicted from memory while its connections stay
 * open — a project left open in a tab costs no DO duration until something
 * actually happens. Three consequences shape everything below:
 *
 *   - Per-connection state lives in each socket's `serializeAttachment`, and
 *     the maps in this class are a cache rebuilt from it on wake (see the
 *     constructor's `blockConcurrencyWhile` hydration).
 *   - The focus leases and the AQU-346 member-removed denylist outlive an
 *     eviction, so they are the DO's only durable state: two keys in DO
 *     storage (never Postgres/R2 — the event log is still sync-worker's).
 *   - The periodic sweep is one `ctx.storage` alarm armed for the next real
 *     deadline, not a 5 s `setInterval` that kept every open project awake
 *     around the clock. Client heartbeats are answered by the runtime
 *     (`setWebSocketAutoResponse`) without waking us at all.
 *
 * The bulk of the logic lives in `project-do-handlers.ts` as pure
 * functions (testable without a DO host), with the hibernation-specific
 * pieces in `project-do-hibernation.ts`; this class is the WebSocket
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
  releaseUserLocks,
  resolveConnId,
  resolveTokenRefresh,
  selectStaleConnections,
  stripPresenceDraft,
  sweepExpiredLeases,
  sweepOrphanedPresence,
  unpackBroadcastBody,
  type LockState,
  type PresenceState,
  type ProjectDoServerMessage,
} from "./project-do-handlers"
import {
  ALARM_SLACK_MS,
  AUTO_RESPONSE_PING_FRAME,
  AUTO_RESPONSE_PONG_FRAME,
  DENIED_USERS_STORAGE_KEY,
  foldAutoResponse,
  LOCKS_STORAGE_KEY,
  nextSweepDeadlineAt,
  parseConnectionAttachment,
  pruneDeniedUsers,
  shouldMoveAlarm,
  toConnectionAttachment,
} from "./project-do-hibernation"
import type { OutboxRawEvent } from "./project-do-types"
import { mondayNotifyProject, notifyMondayProgress } from "./monday-notify"
import { LINK_SYNC_INVOCATION_BUDGET_MS, mirrorSync, type MirrorSyncResult } from "./events/link-sync"
import { makePostgres } from "../../db/shim/postgres"
import { createRerunSingleFlight } from "./lib/rerun-single-flight"
import { serviceBearerMatches } from "./lib/service-auth"

/**
 * AQU-346: how long a member-removed denylist entry blocks reconnects.
 * Must exceed the sync-token TTL (15 min, auth-worker SYNC_TOKEN_TTL_SECONDS)
 * so a removed user's cached-but-still-valid token cannot rejoin; after this
 * window every token minted before the removal has expired and the mint-time
 * gate (auth-worker resolveProjectRole) is the authority again.
 *
 * AQU-1836: mirrored into DO storage (DENIED_USERS_STORAGE_KEY). It used to
 * be in-memory only, which was safe while the DO stayed resident for the
 * whole window — under hibernation an eviction (or a deploy) inside those 16
 * minutes would have handed a removed member its channel back.
 */
const MEMBER_REMOVED_DENY_MS = 16 * 60 * 1000

/**
 * AQU-1836: how often a legacy (ts-stamping) client's ping refreshes its
 * socket attachment. Only those pings reach the DO at all, and the attachment
 * is the sweep's only liveness record across an eviction, so it must not go
 * stale for longer than the heartbeat TTL — but it needn't be rewritten on
 * every single ping either.
 */
const HEARTBEAT_PERSIST_INTERVAL_MS = 30_000

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
 *
 * AQU-1839: a client can now avoid that close by re-authorizing in band — it
 * sends `token.refresh` with a freshly minted token before the current one
 * lapses, which re-resolves the role and pushes `tokenExpiresAt` out. This
 * close is what happens when no valid refresh arrives, so the staleness bound
 * is unchanged: the role is still re-resolved at least once per token TTL,
 * either by a refresh or by the reconnect this close forces.
 */
export const TOKEN_EXPIRED_CLOSE_CODE = 4401

/**
 * AQU-1791: app-specific WS close code for "this socket went silent past the
 * presence heartbeat TTL". The client reconnects on any close, so a
 * live-but-wrongly-swept socket costs one reconnect; a genuinely dead one
 * stops holding a roster row.
 */
export const PRESENCE_STALE_CLOSE_CODE = 4408

/**
 * AQU-1791: app-specific WS close code for "another connection of yours took
 * this presence identity over" — normally the same tab returning after a
 * dirty drop, whose old socket is still here.
 *
 * It is distinct from the TTL code because the client acts on it: a tab
 * duplicated in the browser inherits the original's sessionStorage, so both
 * would present one connId and take it from each other forever. Seeing this
 * code, a client that still believes it is live rotates its stored id, which
 * settles the pair after one round.
 */
export const CONNECTION_SUPERSEDED_CLOSE_CODE = 4409

/**
 * AQU-1839: minimum gap between `token.refresh` frames honoured on one
 * connection. Each one costs an HMAC verification, and the frame is
 * client-driven — this keeps a buggy or hostile client from turning its own
 * socket into a signature-checking treadmill. Far below the lead time a real
 * client refreshes at (tens of seconds before a 15-minute expiry), so it never
 * delays a legitimate refresh or its retries.
 */
const TOKEN_REFRESH_MIN_INTERVAL_MS = 500

interface ConnectionState {
  ws: WebSocket
  /**
   * AQU-1839: the project this socket was authorized for. A `token.refresh`
   * has to re-check the token's project scope, and the DO instance is only
   * conventionally per project — the id arrives on the connect URL, so the
   * connection is the thing that knows it.
   */
  projectId: string
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
  /**
   * AQU-1791: epoch ms of the last frame received on this socket (any frame —
   * the heartbeat `ping` is the one every live client sends unprompted).
   */
  lastSeenAt: number
  /**
   * AQU-1791: set once this socket has sent a `ping`. Only a connection that
   * has proven it heartbeats is subject to the stale sweep — see
   * selectStaleConnections.
   */
  heartbeatSeen: boolean
  /**
   * AQU-1839: epoch ms of the last `token.refresh` frame this socket was
   * charged for — see TOKEN_REFRESH_MIN_INTERVAL_MS.
   */
  lastTokenRefreshAt: number
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

/**
 * AQU-1828: how long a "this project has no Monday link" answer from identity
 * is trusted. Linking/unlinking invalidates it immediately through
 * /__monday-link-changed, so this is only a backstop for a missed notify —
 * long enough that an unlinked project costs ~one request per DO lifetime
 * instead of one per 60s (at 1k active projects that was ~17 req/s of no-ops).
 */
const MONDAY_UNLINKED_TTL_MS = 30 * 60_000

export class ProjectSync extends DurableObject<DOEnv> {
  /** Cache of the live sockets, rebuilt from their attachments on wake. */
  private connections = new Map<WebSocket, ConnectionState>()
  /** Cache too: every row is owned by one socket's attachment. */
  private presence = new Map<string, PresenceState>()
  /** Durable (LOCKS_STORAGE_KEY) — a lease is per user, not per socket. */
  private locks = new Map<string, LockState>()
  /** Set when `locks` diverged from storage; flushed by settle(). */
  private locksDirty = false
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
   * project, so concurrent /__link-sync callers (push accelerator + lazy pull
   * racing) never start overlapping folds — the design spec's "serialized
   * single-flight per downstream through the ProjectSync DO".
   *
   * AQU-1545: a caller that arrives mid-sync is answered by the NEXT run, not
   * the running one. Joining the running fold handed it a read of the upstream
   * from BEFORE the change it was told about (a push frame for a commit that
   * landed mid-sync), and nothing asked again, so a burst of upstream hides
   * left an open downstream short of the last few until a reload. See
   * lib/rerun-single-flight.ts.
   */
  private readonly linkSync = createRerunSingleFlight((projectId: string) => this.runLinkSync(projectId))
  /** Monday push nudge throttle (in-memory; eviction resets it, which is fine —
   *  identity's cron reconciliation covers gaps). */
  private lastMondayNotifyAt = 0
  /** Epoch ms until which identity said this project has no Monday link. */
  private mondayUnlinkedUntil = 0

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env)
    // AQU-1836: the runtime answers the client heartbeat for us. An
    // auto-responded ping never wakes the DO, and
    // `getWebSocketAutoResponseTimestamp` still records that the socket is
    // alive, which is what the stale sweep reads (see foldAutoResponse).
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(AUTO_RESPONSE_PING_FRAME, AUTO_RESPONSE_PONG_FRAME),
    )
    // Rebuild the caches before any event is delivered: after a hibernation
    // the sockets are back but every field above is a fresh empty map.
    ctx.blockConcurrencyWhile(() => this.hydrate())
  }

  /**
   * AQU-1836: restore this DO's view of the world — leases and the denylist
   * from storage, every connection from its own socket's attachment.
   */
  private async hydrate(): Promise<void> {
    const [storedLocks, storedDenied] = await Promise.all([
      this.ctx.storage.get<LockState[]>(LOCKS_STORAGE_KEY),
      this.ctx.storage.get<Record<string, number>>(DENIED_USERS_STORAGE_KEY),
    ])
    for (const lock of storedLocks ?? []) this.locks.set(lock.cellId, lock)
    for (const [userId, until] of Object.entries(storedDenied ?? {})) {
      const numeric = Number(userId)
      if (Number.isFinite(numeric) && typeof until === "number") this.removedUsers.set(numeric, until)
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = parseConnectionAttachment(ws.deserializeAttachment())
      if (!attachment) {
        // No identity we recognise (a socket from a pre-hibernation deploy, a
        // shape change). Guessing one would mis-attribute presence and locks,
        // so retire it — the client reconnects and re-authenticates.
        this.closeUnidentified(ws)
        continue
      }
      const seen = foldAutoResponse(attachment, this.ctx.getWebSocketAutoResponseTimestamp(ws))
      this.connections.set(ws, {
        ws,
        projectId: attachment.projectId,
        connId: attachment.connId,
        userId: attachment.userId,
        numericUserId: attachment.numericUserId,
        role: attachment.role,
        tokenExpiresAt: attachment.tokenExpiresAt,
        lastSeenAt: seen.lastSeenAt,
        heartbeatSeen: seen.heartbeatSeen,
        // The AQU-1839 refresh rate limit is in-memory on purpose: a socket
        // only gets here after an idle gap far longer than the limit itself.
        lastTokenRefreshAt: 0,
      })
      this.presence.set(attachment.connId, attachment.presence)
    }
  }

  private closeUnidentified(ws: WebSocket): void {
    try {
      ws.close(1012, "sync worker restarted")
    } catch {
      /* swallow */
    }
  }

  private async runLinkSync(projectId: string): Promise<MirrorSyncResult> {
    // Test seam takes priority; otherwise build a short-lived PG connection
    // from HYPERDRIVE (this DO instance's own env, not the request-scoped
    // synthesized AQUILLA_PG the worker's top-level fetch uses).
    const db = this.env.AQUILLA_PG ?? makePostgres(this.env.HYPERDRIVE!.connectionString)
    try {
      // AQU-1563: one invocation does a bounded slice of a large sync and
      // reports `more`; the /link/sync route calls again until the link is
      // caught up, so neither CPU time nor memory here grows with the upstream.
      return await mirrorSync(db as AquillaDb, projectId, { budgetMs: LINK_SYNC_INVOCATION_BUDGET_MS })
    } finally {
      if (!this.env.AQUILLA_PG) void (db as { close(): Promise<void> }).close?.()
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // AQU-476: mirror sync trigger, single-flighted per DO instance (see
    // linkSync above). Internal-only, same bearer-secret gate as
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
    // that the folds ran one after the other, never overlapping (the second
    // waits for the first, then runs once more — AQU-1545), and B's cells
    // match A's head afterward.
    if (request.method === "POST" && url.pathname === "/__link-sync") {
      if (!serviceBearerMatches(request.headers.get("Authorization"), this.env)) {
        return new Response("unauthorized", { status: 401 })
      }
      const projectId = url.searchParams.get("project")
      if (!projectId) {
        return new Response("missing project query param", { status: 400 })
      }
      if (!this.env.AQUILLA_PG && !this.env.HYPERDRIVE) {
        return new Response("HYPERDRIVE binding not configured", { status: 500 })
      }
      try {
        const result = await this.linkSync(projectId)
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
      if (mondayProject) this.maybeNotifyMonday(mondayProject)
      return Response.json({ ok: true, recipients: this.connections.size })
    }

    // AQU-1828: identity tells us the project's Monday link changed, so the
    // cached "no link here" answer must go — the next edit nudges again.
    if (request.method === "POST" && url.pathname === "/__monday-link-changed") {
      if (!serviceBearerMatches(request.headers.get("Authorization"), this.env)) {
        return new Response("unauthorized", { status: 401 })
      }
      this.mondayUnlinkedUntil = 0
      this.lastMondayNotifyAt = 0
      return Response.json({ ok: true })
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
      // AQU-1836: durable, so an eviction inside the deny window can't let
      // the removed member back in on a cached-but-valid token.
      await this.persistDeniedUsers()
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
      await this.settle()
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
        this.persistConnection(conn)
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
        await this.persistDeniedUsers()
      }
      userId = auth.claims.username ?? `user:${auth.claims.userId}`
      numericUserId = auth.claims.userId
      role = auth.claims.role
      tokenExpiresAt = auth.claims.exp * 1000
    } else {
      userId = url.searchParams.get("user") ?? "anon"
    }

    const connId = resolveConnId(url.searchParams.get("connId"), this.connections, userId)
    // AQU-1791: the client keeps one connId per tab (sessionStorage), so a tab
    // that reconnects after a dirty drop re-presents the id its dead socket is
    // still holding here. resolveConnId hands the id back only when the holder
    // is this same verified user, so retiring that socket now — before the new
    // row is written — replaces its presence entry instead of accumulating one.
    this.retireSupersededConnection(connId)

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    // AQU-1836: hibernatable accept. Frames arrive at webSocketMessage /
    // webSocketClose below rather than at listeners closed over this scope —
    // that indirection is what lets the runtime evict us between frames while
    // the socket stays open.
    this.ctx.acceptWebSocket(server)

    const conn: ConnectionState = {
      ws: server,
      projectId,
      connId,
      userId,
      numericUserId,
      role,
      tokenExpiresAt,
      lastSeenAt: Date.now(),
      heartbeatSeen: false,
      lastTokenRefreshAt: 0,
    }
    this.connections.set(server, conn)
    const joined: PresenceState = { connId, userId, ts: Date.now() }
    this.presence.set(connId, joined)
    this.persistConnection(conn)
    // Snapshot of current roster (drafts stripped) so the new client sees
    // existing peers; everyone else learns about the newcomer via a diff.
    this.sendTo(server, presenceSnapshot(this.presence))
    // AQU-1839: tell the client when this connection's authorization lapses so
    // it can refresh in band instead of waiting to be closed. Sending the
    // frame at all is what signals support — see ServerTokenExpiry.
    this.sendTo(server, { t: "token.expiry", expiresAt: tokenExpiresAt })
    this.broadcast({ t: "presence.diff", user: stripPresenceDraft(joined) })
    await this.settle()

    return new Response(null, { status: 101, webSocket: client })
  }

  // ── Hibernatable socket events ─────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const conn = this.connections.get(ws)
    if (!conn) {
      // hydrate() retires sockets it can't identify, so this is only reachable
      // if one arrived between that sweep and now. Same answer: let the client
      // reconnect rather than act without an identity.
      this.closeUnidentified(ws)
      return
    }
    await this.handleClientMessage(conn, typeof message === "string" ? message : "")
    await this.settle()
  }

  async webSocketClose(ws: WebSocket, code?: number, reason?: string): Promise<void> {
    const conn = this.connections.get(ws)
    if (conn) this.handleConnectionClose(conn)
    // Complete the closing handshake so the runtime stops handing this socket
    // back from `getWebSockets()` — otherwise a later hydrate() would rebuild
    // a presence row for a connection that is already gone, and only the
    // heartbeat TTL would clear it.
    try {
      ws.close(code === undefined || code === 1005 || code === 1006 ? 1000 : code, reason)
    } catch {
      /* already closed */
    }
    await this.settle()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "socket error")
  }

  /**
   * AQU-1836: the sweep that the 5 s `setInterval` used to run, now armed for
   * the next real deadline (earliest lease expiry, token expiry or heartbeat
   * TTL — see nextSweepDeadlineAt). An alarm that fires with nothing to do
   * just re-arms, so arming early is always safe; arming nothing at all is
   * how an untouched project stops costing DO duration.
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    // AQU-1374: drop rows for sockets that died without firing close/error
    // BEFORE the lease sweep, so it doesn't emit presence.diff frames for
    // rows that are about to disappear anyway.
    this.reapOrphanedPresence()
    // AQU-1791: retire half-open sockets BEFORE the lease sweep too — they
    // are still in `connections`, so reapOrphanedPresence treats their rows
    // as live; closing them here runs the normal disconnect path.
    this.sweepStaleConnections(now)
    const result = sweepExpiredLeases(this.locks, this.presence, now)
    this.locks = result.locks
    this.presence = result.presence
    if (result.emit.length > 0) {
      this.locksDirty = true
      for (const m of result.emit) this.broadcast(m)
      // A cleared focusedCell belongs to the socket's attachment too.
      this.persistAllConnections()
    }
    this.sweepExpiredConnections(now)
    await this.prunePersistedDenials(now)
    await this.settle()
  }

  // ── Outbound helpers ───────────────────────────────────────────────────

  private sendTo(ws: WebSocket, msg: ProjectDoServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      /* swallow */
    }
  }

  /**
   * AQU-1828: nudge identity's Monday push only when this project can plausibly
   * have something to push. identity answers `linked: false` for a project with
   * no enabled link; we cache that and go quiet until the link changes (or the
   * backstop TTL lapses), instead of paying a round trip every 60s forever.
   */
  private maybeNotifyMonday(projectId: string): void {
    const now = Date.now()
    if (now < this.mondayUnlinkedUntil) return
    if (now - this.lastMondayNotifyAt <= MONDAY_NOTIFY_THROTTLE_MS) return
    this.lastMondayNotifyAt = now
    this.ctx.waitUntil(
      notifyMondayProgress(this.env, projectId).then((linked) => {
        if (linked === false) this.mondayUnlinkedUntil = Date.now() + MONDAY_UNLINKED_TTL_MS
        else if (linked === true) this.mondayUnlinkedUntil = 0
      }),
    )
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

  private handleClientMessage(conn: ConnectionState, raw: string): Promise<void> | void {
    const msg = parseProjectDoClientMessage(raw)
    if (!msg) return
    const now = Date.now()
    // AQU-1791: any frame proves the socket is alive; a `ping` additionally
    // proves this client heartbeats, which is what arms the stale sweep.
    conn.lastSeenAt = now
    if (msg.t === "ping") {
      // Only a ping the runtime could not auto-respond to (an older client
      // stamps `ts`, so the frame misses the pair) reaches us here. Record
      // the liveness it proves in the attachment, since the sweep may next
      // read it after an eviction.
      const firstHeartbeat = !conn.heartbeatSeen
      conn.heartbeatSeen = true
      if (firstHeartbeat || now - this.lastPersistedSeenAt(conn) > HEARTBEAT_PERSIST_INTERVAL_MS) {
        this.persistConnection(conn)
      }
      this.sendTo(conn.ws, msg.ts === undefined ? { t: "pong" } : { t: "pong", ts: msg.ts })
      return
    }
    if (msg.t === "token.refresh") {
      // AQU-1836: awaited rather than fired-and-forgotten so webSocketMessage's
      // settle() runs AFTER the refresh has landed — the new expiry has to
      // reach the socket attachment and any locks a downgrade released have
      // to reach storage before the DO may hibernate again.
      return this.handleTokenRefresh(conn, msg.token)
    }
    if (msg.t === "focus.claim") {
      // [Pen test 2026-08-10] a read-only role (viewer/commenter/reviewer)
      // can observe and render the editor but must not be able to hold an
      // edit lock — granting one anyway lets them block every contributor
      // out of a cell indefinitely. Mirrors the write-drop policy already
      // applied to actual content writes (see shouldBeReadOnly callers).
      if (shouldBeReadOnly(conn.role)) return
      const result = applyFocusClaim(this.locks, this.presence, conn, msg, now)
      const granted = result.emit.length > 0
      this.locks = result.locks
      this.presence = result.presence
      if (granted) {
        this.locksDirty = true
        this.persistConnection(conn)
      }
      for (const m of result.emit) this.broadcast(m)
      for (const m of result.emitTo) this.sendTo(conn.ws, m)
      return
    }
    if (msg.t === "focus.renew") {
      if (shouldBeReadOnly(conn.role)) return
      const previousExpiry = this.locks.get(msg.cellId)?.expiresAt
      const result = applyFocusRenew(this.locks, this.presence, conn, msg, now)
      this.locks = result.locks
      // The renewed expiry is what keeps the lease alive across an eviction,
      // so it has to reach storage — otherwise the alarm would wake to a
      // stale deadline and release a cell its owner is still editing. A renew
      // against a lease that is gone (or someone else's) is a no-op here, as
      // it always was, and writes nothing.
      if (this.locks.get(msg.cellId)?.expiresAt !== previousExpiry) this.locksDirty = true
      return
    }
    if (msg.t === "focus.release") {
      const result = applyFocusRelease(this.locks, this.presence, conn, msg, now)
      const released = result.emit.length > 0
      this.locks = result.locks
      this.presence = result.presence
      if (released) {
        this.locksDirty = true
        this.persistConnection(conn)
      }
      for (const m of result.emit) this.broadcast(m)
      return
    }
    if (msg.t === "presence.update") {
      const result = applyPresenceUpdate(this.presence, conn, msg, now)
      this.presence = result.presence
      if (result.emit.length > 0) this.persistConnection(conn)
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

  /**
   * AQU-1839: re-authorize an open socket from a freshly minted token.
   *
   * The DO used to close every connection at its token's expiry, so each tab
   * re-minted and reconnected every 15 minutes — a constant floor of roughly
   * N/900 reconnects per second across the fleet (10k tabs ≈ 11/s), each one
   * costing a socket, a token mint and the AQU-845 resync fan-out, and all of
   * them synchronised because tabs opened together expire together.
   *
   * Accepting the new token in band keeps the socket and still re-resolves the
   * role, which is what the forced close was protecting (see
   * TOKEN_EXPIRED_CLOSE_CODE). A refusal is deliberately quiet: the connection
   * keeps the expiry it already had, so the sweep closes it on schedule and the
   * client reconnects exactly as it does today.
   */
  private async handleTokenRefresh(conn: ConnectionState, token: string): Promise<void> {
    // A connection with no expiry was never token-authorized (the
    // ALLOW_UNAUTHENTICATED dev bypass) — there is nothing to refresh, and
    // honouring a token here would hand it a role it never passed a gate for.
    if (conn.tokenExpiresAt === null) return
    const arrivedAt = Date.now()
    if (arrivedAt - conn.lastTokenRefreshAt < TOKEN_REFRESH_MIN_INTERVAL_MS) return
    conn.lastTokenRefreshAt = arrivedAt
    const auth = await verifyTokenForProject(token, conn.projectId, this.env.SYNC_SECRET_KEY)
    if (!auth.ok) {
      console.warn(`[ProjectSync] token.refresh rejected: ${auth.reason}`)
      return
    }
    // Still in the connection map? A socket closed while we were verifying
    // must not be written back into.
    if (!this.connections.has(conn.ws)) return
    // AQU-346: the same eject gate the connect path applies. A token minted
    // before the removal is still signature-valid, so without this a removed
    // member could hold their socket open past the eject by refreshing it.
    const deniedUntil = this.removedUsers.get(auth.claims.userId)
    if (deniedUntil != null && deniedUntil > Date.now()) {
      try {
        conn.ws.close(MEMBER_REMOVED_CLOSE_CODE, "membership revoked")
      } catch {
        /* swallow */
      }
      this.handleConnectionClose(conn)
      return
    }
    const now = Date.now()
    const outcome = resolveTokenRefresh(conn, auth.claims, now)
    if (!outcome.ok) {
      console.warn(`[ProjectSync] token.refresh rejected: ${outcome.reason}`)
      return
    }
    const wasWriteCapable = !shouldBeReadOnly(conn.role)
    conn.role = outcome.role
    conn.tokenExpiresAt = outcome.tokenExpiresAt
    // AQU-1836: the attachment is what sweepExpiredConnections reads after a
    // wake — left at the old expiry, the alarm armed for it would close this
    // socket on the very schedule the refresh exists to avoid. The alarm
    // itself stays where it is: it fires at the old deadline, finds nothing
    // expired and re-arms for the new one (see settle()).
    this.persistConnection(conn)
    // A downgrade now has to release the locks the close used to release on
    // this socket's way out — otherwise a demoted user keeps every cell they
    // hold until the lease lapses.
    if (wasWriteCapable && shouldBeReadOnly(outcome.role)) {
      const released = releaseUserLocks(this.locks, conn.userId, now)
      this.locks = released.locks
      if (released.emit.length > 0) this.locksDirty = true
      for (const m of released.emit) this.broadcast(m)
    }
    this.sendTo(conn.ws, { t: "token.expiry", expiresAt: outcome.tokenExpiresAt })
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
    if (result.emit.some((m) => m.t === "lock.released")) this.locksDirty = true
    this.locks = result.locks
    this.presence = result.presence
    this.draftThrottle.clear(conn.connId)
    for (const m of result.emit) this.broadcast(m)
  }

  /**
   * AQU-1836: flush what must outlive an eviction, then re-arm the alarm for
   * the next real deadline. Every entry point ends here, and it is the only
   * place that writes DO storage.
   */
  private async settle(): Promise<void> {
    if (this.locksDirty) {
      this.locksDirty = false
      if (this.locks.size === 0) await this.ctx.storage.delete(LOCKS_STORAGE_KEY)
      else await this.ctx.storage.put(LOCKS_STORAGE_KEY, [...this.locks.values()])
    }
    const next = nextSweepDeadlineAt({
      now: Date.now(),
      locks: this.locks.values(),
      connections: this.connections.values(),
    })
    const current = await this.ctx.storage.getAlarm()
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    if (shouldMoveAlarm(current, next, ALARM_SLACK_MS)) await this.ctx.storage.setAlarm(next)
  }

  /** Write a connection's identity + presence row into its socket attachment. */
  private persistConnection(conn: ConnectionState): void {
    try {
      conn.ws.serializeAttachment(toConnectionAttachment(conn, this.presence.get(conn.connId)))
    } catch {
      /* a socket already gone needs no attachment */
    }
  }

  private persistAllConnections(): void {
    for (const conn of this.connections.values()) this.persistConnection(conn)
  }

  /** What this socket's attachment currently claims as its last-seen time. */
  private lastPersistedSeenAt(conn: ConnectionState): number {
    const stored = parseConnectionAttachment(conn.ws.deserializeAttachment())
    return stored?.lastSeenAt ?? 0
  }

  private async persistDeniedUsers(): Promise<void> {
    if (this.removedUsers.size === 0) {
      await this.ctx.storage.delete(DENIED_USERS_STORAGE_KEY)
      return
    }
    const entries: Record<string, number> = {}
    for (const [userId, until] of this.removedUsers) entries[String(userId)] = until
    await this.ctx.storage.put(DENIED_USERS_STORAGE_KEY, entries)
  }

  /** Drop denylist entries whose window has passed (storage hygiene only —
   *  /connect also checks the deadline per entry). */
  private async prunePersistedDenials(now: number): Promise<void> {
    const entries: Record<string, number> = {}
    for (const [userId, until] of this.removedUsers) entries[String(userId)] = until
    const pruned = pruneDeniedUsers(entries, now)
    if (!pruned.changed) return
    this.removedUsers = new Map(
      Object.entries(pruned.entries).map(([userId, until]) => [Number(userId), until]),
    )
    await this.persistDeniedUsers()
  }

  /**
   * AQU-1374: a presence row outliving its socket makes one person show up as
   * several "viewing" peers. Named apart from the imported
   * sweepOrphanedPresence it delegates to, which documents why the live-socket
   * set is the right reconciliation key.
   */
  private reapOrphanedPresence(): void {
    const liveConnIds = new Set<string>()
    for (const state of this.connections.values()) liveConnIds.add(state.connId)
    const result = sweepOrphanedPresence(this.presence, liveConnIds)
    if (result.emit.length === 0) return
    this.presence = result.presence
    for (const m of result.emit) {
      if (m.t === "presence.left") this.draftThrottle.clear(m.connId)
      this.broadcastToAll(m)
    }
  }

  /**
   * AQU-1791: close sockets that stopped heartbeating. A dropped VPN, a
   * sleeping laptop or a carrier handover leaves the socket OPEN here with no
   * close/error event, so its presence row keeps a live connId and the roster
   * keeps showing that person — while their own client reconnects and adds
   * another row. Kathryn Day's field teams saw one tab listed 2–3× as
   * "viewing" for exactly this reason.
   *
   * Closing the socket (rather than only dropping its row) is what keeps the
   * state consistent: handleConnectionClose emits the same presence.left and
   * releases the same per-user locks a clean close would.
   */
  private sweepStaleConnections(now: number): void {
    // AQU-1836: an auto-responded ping never reached webSocketMessage, so the
    // only record that this client is still heartbeating is the runtime's.
    // Fold it in before judging anyone silent.
    for (const conn of this.connections.values()) {
      const seen = foldAutoResponse(conn, this.ctx.getWebSocketAutoResponseTimestamp(conn.ws))
      conn.lastSeenAt = seen.lastSeenAt
      conn.heartbeatSeen = seen.heartbeatSeen
    }
    for (const conn of selectStaleConnections([...this.connections.values()], now)) {
      try {
        conn.ws.close(PRESENCE_STALE_CLOSE_CODE, "presence heartbeat timeout")
      } catch {
        /* swallow */
      }
      // Server-initiated close doesn't reliably fire our own close listener —
      // clean up presence/locks explicitly (idempotent; see the
      // connections.has guard in handleConnectionClose).
      this.handleConnectionClose(conn)
    }
  }

  /**
   * AQU-1791: a returning tab re-presents the connId its previous socket used.
   * resolveConnId only hands that id back when the holder is the same verified
   * user, so the holder is definitively a superseded socket of this very tab —
   * close it and run its disconnect path so the new connection takes over the
   * row instead of adding a second one.
   */
  private retireSupersededConnection(connId: string): void {
    for (const conn of [...this.connections.values()]) {
      if (conn.connId !== connId) continue
      try {
        conn.ws.close(CONNECTION_SUPERSEDED_CLOSE_CODE, "connection superseded")
      } catch {
        /* swallow */
      }
      this.handleConnectionClose(conn)
    }
  }

  /**
   * [Pen test 2026-08-24] A connection's role is resolved once at handshake
   * and cached for the socket's life (see ConnectionState.role) — closing at
   * the token's own expiry re-runs that resolution on reconnect instead of
   * letting a stale role (e.g. after a mid-session downgrade) ride an
   * indefinitely-open socket. AQU-1836: the alarm is armed for the earliest
   * `tokenExpiresAt` across live sockets, so this now runs when a token
   * actually expires rather than within 5 s of it.
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
