/**
 * AQU-1836: the state plumbing that lets `ProjectSync` hibernate.
 *
 * With the WebSocket Hibernation API the DO is evicted from memory between
 * frames while its sockets stay open, so nothing may live *only* in a class
 * field: every entry point reconstructs its world from (a) each socket's
 * attachment and (b) a couple of DO-storage keys. These are the pure pieces
 * of that reconstruction — serialising/parsing an attachment, folding the
 * runtime's auto-response bookkeeping into the heartbeat view, deciding when
 * the next alarm must fire, and pruning the membership denylist — kept here
 * so they are unit-testable without the `cloudflare:workers` host (same
 * reason project-do-handlers.ts exists).
 */

import { PRESENCE_HEARTBEAT_TTL_MS, stripPresenceDraft, type LockState, type PresenceState } from "./project-do-handlers"

/** DO-storage key holding `LockState[]` — focus leases outlive a hibernation. */
export const LOCKS_STORAGE_KEY = "locks"
/**
 * DO-storage key holding `Record<numericUserId, denyUntilEpochMs>` — the
 * AQU-346 member-removed denylist, durable so an eviction or a deploy inside
 * the sync-token TTL can't hand a removed member its channel back.
 */
export const DENIED_USERS_STORAGE_KEY = "denied-users"

/**
 * Exact frame the client heartbeat sends, and the exact answer the runtime
 * returns for it without waking the DO (`setWebSocketAutoResponse`). Both
 * sides must be byte-stable: the pair matches on string equality, so a
 * `ts`-carrying ping (older clients) simply misses and is answered by
 * `webSocketMessage` as before.
 *
 * The client counterpart is `PING_FRAME` in src/lib/sync/ws-reconciler.ts.
 */
export const AUTO_RESPONSE_PING_FRAME = '{"t":"ping"}'
export const AUTO_RESPONSE_PONG_FRAME = '{"t":"pong"}'

/** Don't move the alarm for sub-second differences — it only churns storage. */
export const ALARM_SLACK_MS = 1_000
/** Never arm an alarm tighter than this, however overdue a deadline looks. */
export const ALARM_MIN_DELAY_MS = 250

export const CONNECTION_ATTACHMENT_VERSION = 1

/**
 * Everything about one connection that must survive the DO being evicted
 * while its socket stays open. Capped at 2 KiB by the runtime, so the
 * presence row travels draft-free (`selection.draftText` is ephemeral and is
 * stripped from every snapshot/diff frame anyway).
 */
export interface ConnectionAttachment {
  v: number
  connId: string
  userId: string
  numericUserId: number | null
  role: number | null
  tokenExpiresAt: number | null
  /** Epoch ms of the last frame the DO itself handled on this socket. */
  lastSeenAt: number
  /** Whether this socket has ever been seen to heartbeat. */
  heartbeatSeen: boolean
  /** The connection's presence row, minus any live draft text. */
  presence: PresenceState
}

/** The runtime fields an attachment is built from. */
export interface ConnectionIdentity {
  connId: string
  userId: string
  numericUserId: number | null
  role: number | null
  tokenExpiresAt: number | null
  lastSeenAt: number
  heartbeatSeen: boolean
}

export function toConnectionAttachment(
  conn: ConnectionIdentity,
  presence: PresenceState | undefined,
): ConnectionAttachment {
  const row: PresenceState = presence ?? { connId: conn.connId, userId: conn.userId, ts: conn.lastSeenAt }
  return {
    v: CONNECTION_ATTACHMENT_VERSION,
    connId: conn.connId,
    userId: conn.userId,
    numericUserId: conn.numericUserId,
    role: conn.role,
    tokenExpiresAt: conn.tokenExpiresAt,
    lastSeenAt: conn.lastSeenAt,
    heartbeatSeen: conn.heartbeatSeen,
    presence: stripPresenceDraft(row),
  }
}

/**
 * Parse what `ws.deserializeAttachment()` handed back. Anything we don't
 * recognise (a socket accepted by an older deploy, a shape change) returns
 * null and the caller retires that socket — the client reconnects and gets a
 * clean handshake, which is cheaper than guessing an identity.
 */
export function parseConnectionAttachment(raw: unknown): ConnectionAttachment | null {
  if (typeof raw !== "object" || raw === null) return null
  const a = raw as Partial<ConnectionAttachment>
  if (a.v !== CONNECTION_ATTACHMENT_VERSION) return null
  if (typeof a.connId !== "string" || typeof a.userId !== "string") return null
  if (typeof a.lastSeenAt !== "number" || typeof a.heartbeatSeen !== "boolean") return null
  const numericUserId = typeof a.numericUserId === "number" ? a.numericUserId : null
  const role = typeof a.role === "number" ? a.role : null
  const tokenExpiresAt = typeof a.tokenExpiresAt === "number" ? a.tokenExpiresAt : null
  // The row is keyed by connId and names its owner in every frame it
  // produces, so its identity is re-stamped from the attachment's rather than
  // trusted — a mismatch would address presence.left at a connection nobody
  // has.
  const stored = typeof a.presence === "object" && a.presence !== null ? (a.presence as PresenceState) : null
  const presence: PresenceState = stored
    ? { ...stored, connId: a.connId, userId: a.userId }
    : { connId: a.connId, userId: a.userId, ts: a.lastSeenAt }
  return {
    v: CONNECTION_ATTACHMENT_VERSION,
    connId: a.connId,
    userId: a.userId,
    numericUserId,
    role,
    tokenExpiresAt,
    lastSeenAt: a.lastSeenAt,
    heartbeatSeen: a.heartbeatSeen,
    presence,
  }
}

/**
 * The heartbeat view of a socket, folding in what the runtime answered on our
 * behalf. An auto-responded ping never reaches `webSocketMessage`, so
 * `getWebSocketAutoResponseTimestamp` is the only record that the client is
 * still pinging — and it is also the proof that this client heartbeats at all
 * (the AQU-1791 guard that keeps silent legacy clients out of the sweep).
 */
export function foldAutoResponse(
  conn: { lastSeenAt: number; heartbeatSeen: boolean },
  autoResponseAt: Date | null,
): { lastSeenAt: number; heartbeatSeen: boolean } {
  if (autoResponseAt === null) return { lastSeenAt: conn.lastSeenAt, heartbeatSeen: conn.heartbeatSeen }
  const at = autoResponseAt.getTime()
  return { lastSeenAt: Math.max(conn.lastSeenAt, at), heartbeatSeen: true }
}

export interface SweepDeadlineInput {
  now: number
  locks: Iterable<Pick<LockState, "expiresAt">>
  connections: Iterable<{ tokenExpiresAt: number | null; lastSeenAt: number; heartbeatSeen: boolean }>
  heartbeatTtlMs?: number
  minDelayMs?: number
}

/**
 * When the sweep must next run, or null when there is nothing to sweep.
 *
 * This is what replaces the 5 s `setInterval`: instead of keeping the DO awake
 * to poll, we compute the *exact* next deadline — the earliest lease expiry,
 * token expiry, or heartbeat TTL — and arm one alarm for it. A project left
 * open with no locks wakes roughly once per heartbeat TTL; a project with
 * nothing to watch (every socket closed, or only non-heartbeating dev sockets
 * with no token) arms nothing at all and hibernates.
 */
export function nextSweepDeadlineAt(input: SweepDeadlineInput): number | null {
  const ttl = input.heartbeatTtlMs ?? PRESENCE_HEARTBEAT_TTL_MS
  const minDelay = input.minDelayMs ?? ALARM_MIN_DELAY_MS
  let earliest: number | null = null
  const consider = (at: number): void => {
    if (earliest === null || at < earliest) earliest = at
  }
  for (const lock of input.locks) consider(lock.expiresAt)
  for (const conn of input.connections) {
    if (conn.tokenExpiresAt !== null) consider(conn.tokenExpiresAt)
    if (conn.heartbeatSeen) consider(conn.lastSeenAt + ttl)
  }
  if (earliest === null) return null
  return Math.max(earliest, input.now + minDelay)
}

/**
 * Whether an already-armed alarm still serves `next`. An alarm that fires too
 * early is harmless — the sweep no-ops and re-arms — so we only move it when
 * it would fire materially too late (or isn't armed at all).
 */
export function shouldMoveAlarm(current: number | null, next: number, slackMs: number = ALARM_SLACK_MS): boolean {
  if (current === null) return true
  return current > next + slackMs
}

/**
 * Drop denylist entries whose window has passed: every sync token minted
 * before the removal has expired by then, so the mint-time check in identity
 * is the authority again. Returns a new record plus whether anything changed,
 * so callers only write storage when it did.
 */
export function pruneDeniedUsers(
  entries: Readonly<Record<string, number>>,
  now: number,
): { entries: Record<string, number>; changed: boolean } {
  const kept: Record<string, number> = {}
  let changed = false
  for (const [userId, until] of Object.entries(entries)) {
    if (typeof until !== "number" || until <= now) {
      changed = true
      continue
    }
    kept[userId] = until
  }
  return { entries: kept, changed }
}
