/**
 * Pure handlers extracted from ProjectSync DO for unit testability.
 *
 * The DO runtime can't be instantiated in vitest (needs the
 * `cloudflare:workers` host), so we extract the wire-format parsing +
 * lock-state transitions into pure functions. The DO class becomes a thin
 * wrapper that owns the WebSocket lifecycle and forwards to these.
 */

import type { OutboxRawEvent, OutboxEventKind } from "./project-do-types"

/** Default lease in ms. */
export const PROJECT_DO_DEFAULT_LEASE_MS = 30_000
export const PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH = 16_384

export interface PresenceState {
  userId: string
  focusedCell?: string
  currentFileId?: string
  selection?: PresenceSelection
  ts: number
}

export interface PresenceSelection {
  side: "target"
  anchor: number
  head: number
  /** Ephemeral, bounded text used to render a live remote caret. */
  draftText?: string
}

export interface LockState {
  cellId: string
  userId: string
  expiresAt: number
}

// ── Server → client frames ───────────────────────────────────────────────

export interface ServerEventApplied {
  t: "event.applied"
  id: string
  kind: OutboxEventKind
  project: string
  file?: string
  cell?: string
  /** Verified author username (JWT claims) — clients suppress the
   * "changed elsewhere" banner when this matches their own identity. */
  by?: string
}
export interface ServerEventStale {
  t: "event.stale"
  id: string
  reason: string
}
export interface ServerPresence {
  t: "presence"
  users: PresenceState[]
}
export interface ServerLockClaimed {
  t: "lock.claimed"
  cellId: string
  by: { userId: string; ts: number }
}
export interface ServerLockReleased {
  t: "lock.released"
  cellId: string
  by: { userId: string; ts: number }
}
export interface ServerProjectArchived {
  t: "project.archived"
  project: string
  archivedAt: string | null
  deletedBy: string | null
}
/** Identity owns the durable settings row; this frame refreshes connected
 * clients' overlays and validation-derived progress immediately. */
export interface ServerProjectSettingsUpdated {
  t: "project.settings.updated"
  project: string
  version: number
}
/** Sent after the first, file-creating bulk-import chunk has committed. */
export interface ServerFileProgressUpdated {
  t: "file.progress.updated"
  project: string
  file: string
  fileCreated: boolean
}
/**
 * AQU-346: sent to a removed member's own sockets right before the DO
 * closes them (code 4403). `userId` is the presence identity (username) —
 * the same identity used in presence/lock frames — so the client can
 * compare against its currentUsername.
 */
export interface ServerMemberRemoved {
  t: "member.removed"
  project: string
  userId: string
}
/**
 * AQU-479 push accelerator: notifies a live downstream's connected clients
 * that its upstream committed lane-relevant changes. This is a REALTIME
 * message only — never written to the `events` table, never load-bearing
 * (see the linked-projects design spec §8). A missed/dropped frame is
 * recovered by the existing lazy-pull mirror sync (AQU-476) on next file
 * open; this frame only shaves the latency down to "seconds" for clients
 * that are already connected.
 */
export interface ServerLinkUpstreamChanged {
  t: "link.upstream-changed"
  /** Downstream project this frame targets (the DO's own project id). */
  project: string
  /** Upstream project that committed the change. */
  upstream: string
  /** Highest upstream server_seq in the committed batch — an upper bound the
   *  client can compare against its own last-seen cursor (advisory only;
   *  the authoritative cursor lives server-side in `link-sync.ts`). */
  untilSeq: number
  /** Files touched by the batch (uncapped — batches are already request-scoped). */
  fileIds: string[]
  /** Cell ids touched by the batch, capped (see route.ts) — enough to hint a
   *  targeted refetch without growing the frame unbounded for big imports. */
  cellIds: string[]
}
export type ProjectDoServerMessage =
  | ServerEventApplied
  | ServerEventStale
  | ServerPresence
  | ServerLockClaimed
  | ServerLockReleased
  | ServerProjectArchived
  | ServerProjectSettingsUpdated
  | ServerFileProgressUpdated
  | ServerMemberRemoved
  | ServerLinkUpstreamChanged

/**
 * Additive `__broadcast` envelope (PERF-8): POST /events batches all of a
 * project's `event.applied` frames into ONE subrequest per (project, request)
 * instead of one per committed event. The DO unpacks it into the same
 * per-message WS frames clients already parse — the client protocol is
 * unchanged.
 */
export interface ProjectDoBroadcastBatch {
  t: "broadcast.batch"
  messages: ProjectDoServerMessage[]
}

/**
 * Unpack a `__broadcast` POST body into the server frames to fan out.
 *
 * Accepts BOTH the legacy single-message body (any JSON value — mirroring the
 * old handler's cast-and-broadcast leniency; callers are trusted internal
 * workers behind the SYNC_SECRET_KEY gate) and the batched envelope above.
 * A malformed envelope (non-array `messages`) yields no frames rather than
 * leaking the raw envelope to WS clients.
 */
export function unpackBroadcastBody(body: unknown): ProjectDoServerMessage[] {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const m = body as Record<string, unknown>
    if (m.t === "broadcast.batch") {
      return Array.isArray(m.messages) ? (m.messages as ProjectDoServerMessage[]) : []
    }
  }
  return [body as ProjectDoServerMessage]
}

// ── Client → server frames ───────────────────────────────────────────────

export interface ClientOutboxEvent {
  t: "outbox.event"
  event: OutboxRawEvent
}
export interface ClientFocusClaim {
  t: "focus.claim"
  cellId: string
  leaseMs?: number
}
export interface ClientFocusRenew {
  t: "focus.renew"
  cellId: string
}
export interface ClientFocusRelease {
  t: "focus.release"
  cellId: string
}
export interface ClientPresenceUpdate {
  t: "presence.update"
  currentFileId?: string | null
  focusedCell?: string | null
  selection?: PresenceSelection | null
}
export type ProjectDoClientMessage =
  | ClientOutboxEvent
  | ClientFocusClaim
  | ClientFocusRenew
  | ClientFocusRelease
  | ClientPresenceUpdate

/**
 * Parse a wire-format JSON string into a typed client message. Returns null
 * when the frame is malformed.
 */
export function parseProjectDoClientMessage(raw: string): ProjectDoClientMessage | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object") return null
  const m = obj as Record<string, unknown>
  const t = m.t
  if (t === "focus.claim") {
    if (typeof m.cellId !== "string") return null
    return {
      t: "focus.claim",
      cellId: m.cellId,
      ...(typeof m.leaseMs === "number" ? { leaseMs: m.leaseMs } : {}),
    }
  }
  if (t === "focus.renew" || t === "focus.release") {
    if (typeof m.cellId !== "string") return null
    return { t, cellId: m.cellId }
  }
  if (t === "presence.update") {
    const out: ClientPresenceUpdate = { t: "presence.update" }
    if ("currentFileId" in m) {
      if (m.currentFileId !== null && typeof m.currentFileId !== "string") return null
      out.currentFileId = m.currentFileId
    }
    if ("focusedCell" in m) {
      if (m.focusedCell !== null && typeof m.focusedCell !== "string") return null
      out.focusedCell = m.focusedCell
    }
    if ("selection" in m) {
      if (m.selection !== null && !isPresenceSelection(m.selection)) return null
      out.selection = m.selection
    }
    return out
  }
  if (t === "outbox.event") {
    const ev = m.event
    if (!ev || typeof ev !== "object") return null
    return { t: "outbox.event", event: ev as OutboxRawEvent }
  }
  return null
}

// ── Lock state transitions (pure) ─────────────────────────────────────────

export interface LockTransitionResult {
  /** New locks map. */
  locks: Map<string, LockState>
  /** New presence map. */
  presence: Map<string, PresenceState>
  /** Server frames to broadcast (in order). */
  emit: ProjectDoServerMessage[]
  /**
   * Frames to send only to the requesting connection — used when a claim is
   * rejected because someone else holds the lock; the server tells the
   * requestor about the existing holder so its optimistic UI can roll back.
   */
  emitTo: ProjectDoServerMessage[]
}

function clone<K, V>(m: ReadonlyMap<K, V>): Map<K, V> {
  return new Map(m)
}

function isPresenceSelection(value: unknown): value is PresenceSelection {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    v.side === "target" &&
    typeof v.anchor === "number" &&
    Number.isFinite(v.anchor) &&
    typeof v.head === "number" &&
    Number.isFinite(v.head) &&
    (v.draftText === undefined ||
      (typeof v.draftText === "string" &&
        v.draftText.length <= PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH))
  )
}

function sameSelection(a: PresenceSelection | undefined, b: PresenceSelection | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.side === b.side &&
    a.anchor === b.anchor &&
    a.head === b.head &&
    a.draftText === b.draftText
  )
}

function samePresence(a: PresenceState | undefined, b: PresenceState | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.userId === b.userId &&
    a.focusedCell === b.focusedCell &&
    a.currentFileId === b.currentFileId &&
    a.ts === b.ts &&
    sameSelection(a.selection, b.selection)
  )
}

function clearFocusedPresence(cur: PresenceState, now: number): PresenceState {
  return {
    userId: cur.userId,
    ...(cur.currentFileId ? { currentFileId: cur.currentFileId } : {}),
    ts: now,
  }
}

/**
 * Handle a focus.claim request from a client.
 *
 * RACE-5 ack contract (verified, no changes needed):
 *   - On DENY  → result.emitTo carries a `lock.claimed` frame naming the current
 *     holder; the DO sends it synchronously to the requesting connection only.
 *     The claimer's optimistic UI can roll back immediately without waiting for
 *     a broadcast round-trip.
 *   - On GRANT → result.emit carries `lock.claimed` + `presence` broadcast to
 *     ALL connections (including the claimer). Because the DO is single-threaded
 *     per-instance and processes messages sequentially, the grant is serialised —
 *     no two concurrent claims for the same cell can both succeed.
 *
 * Wave-2 client contract: EditorTable should listen for the `emitTo` deny path
 * (a `lock.claimed` message where `by.userId !== currentUser`) to roll back an
 * optimistic UI lock claim instantly, rather than waiting for the broadcast echo.
 */
export function applyFocusClaim(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  userId: string,
  msg: ClientFocusClaim,
  now: number,
): LockTransitionResult {
  const leaseMs = msg.leaseMs ?? PROJECT_DO_DEFAULT_LEASE_MS
  const nextLocks = clone(locks)
  const nextPresence = clone(presence)
  const existing = nextLocks.get(msg.cellId)
  if (existing && existing.userId !== userId && existing.expiresAt > now) {
    return {
      locks: nextLocks,
      presence: nextPresence,
      emit: [],
      emitTo: [
        {
          t: "lock.claimed",
          cellId: msg.cellId,
          by: { userId: existing.userId, ts: existing.expiresAt - leaseMs },
        },
      ],
    }
  }
  nextLocks.set(msg.cellId, {
    cellId: msg.cellId,
    userId,
    expiresAt: now + leaseMs,
  })
  const cur = nextPresence.get(userId) ?? { userId, ts: now }
  const { selection, ...rest } = cur
  nextPresence.set(userId, {
    ...rest,
    focusedCell: msg.cellId,
    ...(cur.focusedCell === msg.cellId && selection ? { selection } : {}),
    ts: now,
  })
  return {
    locks: nextLocks,
    presence: nextPresence,
    emit: [
      { t: "lock.claimed", cellId: msg.cellId, by: { userId, ts: now } },
      { t: "presence", users: Array.from(nextPresence.values()) },
    ],
    emitTo: [],
  }
}

export function applyFocusRenew(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  userId: string,
  msg: ClientFocusRenew,
  now: number,
  leaseMs: number = PROJECT_DO_DEFAULT_LEASE_MS,
): LockTransitionResult {
  const nextLocks = clone(locks)
  const lock = nextLocks.get(msg.cellId)
  if (lock && lock.userId === userId) {
    nextLocks.set(msg.cellId, { ...lock, expiresAt: now + leaseMs })
  }
  return { locks: nextLocks, presence: new Map(presence), emit: [], emitTo: [] }
}

export function applyFocusRelease(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  userId: string,
  msg: ClientFocusRelease,
  now: number,
): LockTransitionResult {
  const nextLocks = clone(locks)
  const nextPresence = clone(presence)
  const lock = nextLocks.get(msg.cellId)
  if (!lock || lock.userId !== userId) {
    return { locks: nextLocks, presence: nextPresence, emit: [], emitTo: [] }
  }
  nextLocks.delete(msg.cellId)
  const cur = nextPresence.get(userId)
  if (cur && cur.focusedCell === msg.cellId) {
    nextPresence.set(userId, clearFocusedPresence(cur, now))
  }
  return {
    locks: nextLocks,
    presence: nextPresence,
    emit: [
      { t: "lock.released", cellId: msg.cellId, by: { userId, ts: now } },
      { t: "presence", users: Array.from(nextPresence.values()) },
    ],
    emitTo: [],
  }
}

export function applyPresenceUpdate(
  presence: ReadonlyMap<string, PresenceState>,
  userId: string,
  msg: ClientPresenceUpdate,
  now: number,
): { presence: Map<string, PresenceState>; emit: ProjectDoServerMessage[] } {
  const nextPresence = clone(presence)
  const before = nextPresence.get(userId)
  const next: PresenceState = { ...(before ?? { userId, ts: now }), userId, ts: now }

  if ("currentFileId" in msg) {
    if (typeof msg.currentFileId === "string") {
      next.currentFileId = msg.currentFileId
    } else {
      delete next.currentFileId
    }
  }
  if ("focusedCell" in msg) {
    if (typeof msg.focusedCell === "string") {
      // Focus is lock-bearing and must be granted only by focus.claim.
      // presence.update may keep/refresh the existing focused cell, but it
      // cannot acquire a new one by itself.
      if (next.focusedCell !== msg.focusedCell) delete next.selection
    } else {
      delete next.focusedCell
      delete next.selection
    }
  }
  if ("selection" in msg) {
    if (msg.selection && next.focusedCell) {
      next.selection = msg.selection
    } else {
      delete next.selection
    }
  }

  if (samePresence(before, next)) {
    return { presence: nextPresence, emit: [] }
  }

  nextPresence.set(userId, next)
  return {
    presence: nextPresence,
    emit: [{ t: "presence", users: Array.from(nextPresence.values()) }],
  }
}

/**
 * On WS close: drop the user's presence + release all locks they held.
 *
 * Multi-tab safety: focus-locks are per-user (not per-connection) — a lock
 * claimed from tab A must survive tab B closing. Pass `remainingConnectionsForUser`
 * (number of OTHER connections the DO still has open for this userId after
 * removing the closing one). When > 0, we leave locks and presence intact
 * so the other tabs can keep editing without losing their claimed cells.
 */
export function applyDisconnect(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  userId: string,
  now: number,
  remainingConnectionsForUser = 0,
): LockTransitionResult {
  // If other tabs still hold a connection for this user, do not release locks
  // or presence — they are per-user, not per-connection.
  if (remainingConnectionsForUser > 0) {
    return {
      locks: clone(locks),
      presence: clone(presence),
      emit: [],
      emitTo: [],
    }
  }
  const nextLocks = clone(locks)
  const nextPresence = clone(presence)
  nextPresence.delete(userId)
  const released: string[] = []
  for (const [cellId, lock] of nextLocks) {
    if (lock.userId !== userId) continue
    nextLocks.delete(cellId)
    released.push(cellId)
  }
  const emit: ProjectDoServerMessage[] = released.map((cellId) => ({
    t: "lock.released",
    cellId,
    by: { userId, ts: now },
  }))
  emit.push({ t: "presence", users: Array.from(nextPresence.values()) })
  return { locks: nextLocks, presence: nextPresence, emit, emitTo: [] }
}

/** Sweep expired leases. Returns the leases that were dropped. */
export function sweepExpiredLeases(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  now: number,
): { locks: Map<string, LockState>; presence: Map<string, PresenceState>; emit: ProjectDoServerMessage[] } {
  const next = clone(locks)
  const nextPresence = clone(presence)
  const emit: ProjectDoServerMessage[] = []
  for (const [cellId, lock] of next) {
    if (lock.expiresAt > now) continue
    next.delete(cellId)
    const cur = nextPresence.get(lock.userId)
    if (cur?.focusedCell === cellId) {
      nextPresence.set(lock.userId, clearFocusedPresence(cur, now))
    }
    emit.push({
      t: "lock.released",
      cellId,
      by: { userId: lock.userId, ts: now },
    })
  }
  return { locks: next, presence: nextPresence, emit }
}
