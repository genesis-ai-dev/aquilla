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

export interface PresenceState {
  userId: string
  focusedCell?: string
  ts: number
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
  /** Username of the actor that produced the event. Lets the receiving
   *  client distinguish its own writes from those of other collaborators —
   *  the "remote changed while editing" banner only triggers on the latter. */
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
  deletedBy?: string | null
}
export type ProjectDoServerMessage =
  | ServerEventApplied
  | ServerEventStale
  | ServerPresence
  | ServerLockClaimed
  | ServerLockReleased
  | ServerProjectArchived

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
export type ProjectDoClientMessage =
  | ClientOutboxEvent
  | ClientFocusClaim
  | ClientFocusRenew
  | ClientFocusRelease

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
  nextPresence.set(userId, { ...cur, focusedCell: msg.cellId, ts: now })
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
    nextPresence.set(userId, { userId, ts: now })
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

/** On WS close: drop the user's presence + release all locks they held. */
export function applyDisconnect(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  userId: string,
  now: number,
): LockTransitionResult {
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
  now: number,
): { locks: Map<string, LockState>; emit: ProjectDoServerMessage[] } {
  const next = clone(locks)
  const emit: ProjectDoServerMessage[] = []
  for (const [cellId, lock] of next) {
    if (lock.expiresAt > now) continue
    next.delete(cellId)
    emit.push({
      t: "lock.released",
      cellId,
      by: { userId: lock.userId, ts: now },
    })
  }
  return { locks: next, emit }
}
