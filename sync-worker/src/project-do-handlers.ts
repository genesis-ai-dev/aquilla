/**
 * Pure handlers extracted from ProjectSync DO for unit testability.
 *
 * The DO runtime can't be instantiated in vitest (needs the
 * `cloudflare:workers` host), so we extract the wire-format parsing +
 * lock-state transitions into pure functions. The DO class becomes a thin
 * wrapper that owns the WebSocket lifecycle and forwards to these.
 */

import type { OutboxRawEvent, OutboxEventKind } from "./project-do-types"
import type { ContextualFrame } from "./contextual-frames"
import type { CellRowOut } from "./events/cell-row-serialize"

/** Default lease in ms. */
export const PROJECT_DO_DEFAULT_LEASE_MS = 30_000
export const PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH = 16_384

export interface PresenceState {
  /**
   * Stable id of the WebSocket connection this row belongs to. Presence is
   * keyed per CONNECTION, not per user: two tabs (or two people sharing one
   * test account) are two rows carrying the same `userId`. Clients filter
   * "self" by their own connId, never by username.
   */
  connId: string
  userId: string
  /** Lock-bearing: the cell this user holds the edit lease on (focus.claim). */
  focusedCell?: string
  /**
   * Non-lock-bearing "where I am": the row the user has selected/focused in
   * the grid, whether or not they hold (or can hold) its edit lease. Set
   * freely by `presence.update` so viewers, reviewers and contributors whose
   * claim was denied are still visible on the cell they are looking at.
   */
  viewingCell?: string
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
  /** Set when the write arrived via the external Agent API channel
   * (token-bridge minted token). Clients must NOT treat such frames as
   * own-write echoes even when `by` matches their identity — the agent's
   * commit made no local outbox write, so the echo refetch is the only way
   * the approving human's editor learns the result. */
  via?: "external"
  /** `events.server_seq` of this event. Present on chain-mutating and
   * validation cell events (additive — older workers omit it). */
  serverSeq?: number
  /** The cell's CURRENT projected rows (both sides, all lanes) AFTER this
   * event's transaction committed, serialised exactly as the by-ids read
   * (GET …/cells?cellIds=) returns them, so clients can apply them without a
   * follow-up refetch. Omitted when a single request touched more than
   * `EVENT_APPLIED_ROWS_MAX_CELLS` cells (clients fall back to refetch). */
  rows?: CellRowOut[]
}
export interface ServerEventStale {
  t: "event.stale"
  id: string
  reason: string
}
/**
 * Full roster snapshot. Sent to a connection on connect. Never carries
 * `selection.draftText` — live drafts travel in `presence.draft`.
 */
export interface ServerPresence {
  t: "presence"
  users: PresenceState[]
}
/** Exactly one user's presence changed. No `selection.draftText`. */
export interface ServerPresenceDiff {
  t: "presence.diff"
  user: PresenceState
}
/** One connection's presence was removed (that socket closed). */
export interface ServerPresenceLeft {
  t: "presence.left"
  userId: string
  connId: string
}
/**
 * Live draft text for a remote caret. The DO rate-limits this per user
 * (see PresenceDraftThrottle) — coalesce: latest wins.
 */
export interface ServerPresenceDraft {
  t: "presence.draft"
  userId: string
  connId: string
  cellId: string
  draftText: string
  ts: number
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
/**
 * Slice D2: relay of contextual-pipeline activity (run state / scene / span
 * progress) to connected clients. REALTIME ONLY — never written to the event
 * log, never load-bearing; the SPA re-hydrates its mirror from the run
 * snapshot on file open, this frame just removes the polling latency.
 */
export interface ServerContextualActivity {
  t: "contextual.activity"
  project: string
  frame: ContextualFrame
}
export type ProjectDoServerMessage =
  | ServerEventApplied
  | ServerEventStale
  | ServerPresence
  | ServerPresenceDiff
  | ServerPresenceLeft
  | ServerPresenceDraft
  | ServerLockClaimed
  | ServerLockReleased
  | ServerProjectArchived
  | ServerProjectSettingsUpdated
  | ServerFileProgressUpdated
  | ServerMemberRemoved
  | ServerLinkUpstreamChanged
  | ServerContextualActivity

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
  viewingCell?: string | null
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
    if ("viewingCell" in m) {
      if (m.viewingCell !== null && typeof m.viewingCell !== "string") return null
      out.viewingCell = m.viewingCell
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

/**
 * Accept the client's connId when it is a sane opaque token and not already
 * held by a live socket; otherwise mint one. A collision can only come from a
 * buggy/malicious client — never merge two sockets onto one presence row.
 */
export function resolveConnId(
  requested: string | null,
  connections: ReadonlyMap<unknown, { connId: string }>,
): string {
  if (requested && /^[A-Za-z0-9_-]{8,64}$/.test(requested)) {
    let taken = false
    for (const c of connections.values()) {
      if (c.connId === requested) {
        taken = true
        break
      }
    }
    if (!taken) return requested
  }
  return crypto.randomUUID()
}

// ── Lock state transitions (pure) ─────────────────────────────────────────

/**
 * Who is acting: the socket (`connId`, presence key) and the verified user
 * behind it (`userId`, lock owner). Locks stay per USER — see applyDisconnect.
 */
export interface PresenceIdentity {
  connId: string
  userId: string
}

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

/**
 * Content equality, deliberately ignoring `ts`: every presence.update stamps
 * `ts = now`, so comparing it made this always false and turned each
 * unchanged repeat (selection re-sends, resumed tabs) into a fan-out
 * `presence.diff` to every peer.
 */
function samePresence(a: PresenceState | undefined, b: PresenceState | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.connId === b.connId &&
    a.userId === b.userId &&
    a.focusedCell === b.focusedCell &&
    a.viewingCell === b.viewingCell &&
    a.currentFileId === b.currentFileId &&
    sameSelection(a.selection, b.selection)
  )
}

/** Copy of a presence row with `selection.draftText` removed. */
export function stripPresenceDraft(user: PresenceState): PresenceState {
  if (!user.selection || user.selection.draftText === undefined) return user
  const { draftText: _draft, ...selection } = user.selection
  return { ...user, selection }
}

/** Full roster frame with every draft stripped (connect snapshot). */
export function presenceSnapshot(presence: ReadonlyMap<string, PresenceState>): ServerPresence {
  return { t: "presence", users: Array.from(presence.values(), stripPresenceDraft) }
}

function presenceDiff(user: PresenceState): ServerPresenceDiff {
  return { t: "presence.diff", user: stripPresenceDraft(user) }
}

function clearFocusedPresence(cur: PresenceState, now: number): PresenceState {
  return {
    connId: cur.connId,
    userId: cur.userId,
    ...(cur.currentFileId ? { currentFileId: cur.currentFileId } : {}),
    // Losing the lease does not move the user: they are still on that row.
    ...(cur.viewingCell ? { viewingCell: cur.viewingCell } : {}),
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
 *   - On GRANT → result.emit carries `lock.claimed` + `presence.diff` broadcast to
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
  who: PresenceIdentity,
  msg: ClientFocusClaim,
  now: number,
): LockTransitionResult {
  const { connId, userId } = who
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
  const cur = nextPresence.get(connId) ?? { connId, userId, ts: now }
  const { selection, ...rest } = cur
  const nextUser: PresenceState = {
    ...rest,
    focusedCell: msg.cellId,
    ...(cur.focusedCell === msg.cellId && selection ? { selection } : {}),
    ts: now,
  }
  nextPresence.set(connId, nextUser)
  return {
    locks: nextLocks,
    presence: nextPresence,
    emit: [
      { t: "lock.claimed", cellId: msg.cellId, by: { userId, ts: now } },
      presenceDiff(nextUser),
    ],
    emitTo: [],
  }
}

export function applyFocusRenew(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  who: PresenceIdentity,
  msg: ClientFocusRenew,
  now: number,
  leaseMs: number = PROJECT_DO_DEFAULT_LEASE_MS,
): LockTransitionResult {
  const nextLocks = clone(locks)
  const lock = nextLocks.get(msg.cellId)
  if (lock && lock.userId === who.userId) {
    nextLocks.set(msg.cellId, { ...lock, expiresAt: now + leaseMs })
  }
  return { locks: nextLocks, presence: new Map(presence), emit: [], emitTo: [] }
}

export function applyFocusRelease(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  who: PresenceIdentity,
  msg: ClientFocusRelease,
  now: number,
): LockTransitionResult {
  const { connId, userId } = who
  const nextLocks = clone(locks)
  const nextPresence = clone(presence)
  const lock = nextLocks.get(msg.cellId)
  if (!lock || lock.userId !== userId) {
    return { locks: nextLocks, presence: nextPresence, emit: [], emitTo: [] }
  }
  nextLocks.delete(msg.cellId)
  const emit: ProjectDoServerMessage[] = [
    { t: "lock.released", cellId: msg.cellId, by: { userId, ts: now } },
  ]
  // Only the releasing socket's row loses focusedCell. A sibling tab of the
  // same user that is still in the cell keeps its row and re-claims the
  // lease itself on the lock.released echo (client AQU-1154 path).
  const cur = nextPresence.get(connId)
  if (cur && cur.focusedCell === msg.cellId) {
    const cleared = clearFocusedPresence(cur, now)
    nextPresence.set(connId, cleared)
    emit.push(presenceDiff(cleared))
  }
  return { locks: nextLocks, presence: nextPresence, emit, emitTo: [] }
}

export function applyPresenceUpdate(
  presence: ReadonlyMap<string, PresenceState>,
  who: PresenceIdentity,
  msg: ClientPresenceUpdate,
  now: number,
): { presence: Map<string, PresenceState>; emit: ProjectDoServerMessage[] } {
  const { connId, userId } = who
  const nextPresence = clone(presence)
  const before = nextPresence.get(connId)
  const next: PresenceState = { ...(before ?? { connId, userId, ts: now }), connId, userId, ts: now }

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
  if ("viewingCell" in msg) {
    if (typeof msg.viewingCell === "string") next.viewingCell = msg.viewingCell
    else delete next.viewingCell
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

  nextPresence.set(connId, next)
  const emit: ProjectDoServerMessage[] = [presenceDiff(next)]
  const draftText = next.selection?.draftText
  if (
    draftText !== undefined &&
    next.focusedCell &&
    draftText !== before?.selection?.draftText
  ) {
    emit.push({
      t: "presence.draft",
      userId,
      connId,
      cellId: next.focusedCell,
      draftText,
      ts: now,
    })
  }
  return { presence: nextPresence, emit }
}

/**
 * Per-connection trailing throttle for `presence.draft` frames: the first draft in
 * a window goes out immediately; anything else arriving inside the window is
 * held and only the LATEST one is flushed when the window ends. In-memory
 * only (timers die with the DO instance, like the rest of its state).
 */
export const PRESENCE_DRAFT_THROTTLE_MS = 150

export class PresenceDraftThrottle {
  private readonly windows = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; pending: ServerPresenceDraft | null }
  >()

  constructor(
    private readonly send: (frame: ServerPresenceDraft) => void,
    private readonly windowMs: number = PRESENCE_DRAFT_THROTTLE_MS,
  ) {}

  push(frame: ServerPresenceDraft): void {
    const open = this.windows.get(frame.connId)
    if (open) {
      open.pending = frame
      return
    }
    this.send(frame)
    this.arm(frame.connId)
  }

  /** Drop any held draft + timer for a connection (disconnect). */
  clear(connId: string): void {
    const open = this.windows.get(connId)
    if (!open) return
    clearTimeout(open.timer)
    this.windows.delete(connId)
  }

  private arm(connId: string): void {
    const timer = setTimeout(() => {
      const open = this.windows.get(connId)
      if (!open) return
      if (open.pending) {
        const frame = open.pending
        open.pending = null
        this.send(frame)
        this.arm(connId)
      } else {
        this.windows.delete(connId)
      }
    }, this.windowMs)
    this.windows.set(connId, { timer, pending: null })
  }
}

/**
 * On WS close: drop THIS connection's presence row (always — presence is
 * per-connection) and release the user's locks only when no other socket of
 * theirs remains.
 *
 * Multi-tab safety: focus-locks are per-user (not per-connection) — a lock
 * claimed from tab A must survive tab B closing. Pass `remainingConnectionsForUser`
 * (number of OTHER connections the DO still has open for this userId after
 * removing the closing one). When > 0, locks stay intact so the other tabs
 * can keep editing without losing their claimed cells.
 */
export function applyDisconnect(
  locks: ReadonlyMap<string, LockState>,
  presence: ReadonlyMap<string, PresenceState>,
  who: PresenceIdentity,
  now: number,
  remainingConnectionsForUser = 0,
): LockTransitionResult {
  const { connId, userId } = who
  const nextLocks = clone(locks)
  const nextPresence = clone(presence)
  const hadPresence = nextPresence.delete(connId)
  const emit: ProjectDoServerMessage[] = []
  if (remainingConnectionsForUser === 0) {
    for (const [cellId, lock] of nextLocks) {
      if (lock.userId !== userId) continue
      nextLocks.delete(cellId)
      emit.push({ t: "lock.released", cellId, by: { userId, ts: now } })
    }
  }
  if (hadPresence) emit.push({ t: "presence.left", userId, connId })
  return { locks: nextLocks, presence: nextPresence, emit, emitTo: [] }
}

/**
 * AQU-1374: reconcile the presence roster against the DO's live sockets.
 *
 * Presence rows are created at handshake and removed by applyDisconnect, which
 * only runs when the socket's `close`/`error` event fires. A connection that
 * dies without one — a sleeping laptop, a dropped mobile network, a tunnel
 * killed mid-flight — leaves its row behind forever, because nothing else ever
 * revisits the map. The client reconnects under a FRESH connId (see
 * ws-reconciler's `?connId=`, generated per socket session), so each silent
 * drop adds a row rather than replacing one: one person in one tab was showing
 * up as six "viewing" peers to everyone else on the project.
 *
 * Every row is keyed by the connId of the socket that created it, so a row
 * whose connId no longer has a live connection is definitively orphaned. That
 * makes this exact rather than heuristic — unlike a `ts`-based TTL, which would
 * evict a live but idle user, since the client sends `presence.update` only on
 * change and has no heartbeat.
 *
 * Emits `presence.left` per dropped row, the same frame applyDisconnect sends,
 * so `PresenceStore.applyPresenceLeft` removes the peer with no client change.
 */
export function sweepOrphanedPresence(
  presence: ReadonlyMap<string, PresenceState>,
  liveConnIds: ReadonlySet<string>,
): { presence: Map<string, PresenceState>; emit: ProjectDoServerMessage[] } {
  const nextPresence = clone(presence)
  const emit: ProjectDoServerMessage[] = []
  for (const [connId, cur] of nextPresence) {
    if (liveConnIds.has(connId)) continue
    nextPresence.delete(connId)
    emit.push({ t: "presence.left", userId: cur.userId, connId })
  }
  return { presence: nextPresence, emit }
}

/**
 * Sweep expired leases. Emits `lock.released` per dropped lease plus a
 * `presence.diff` for each user whose focused cell was cleared by it.
 */
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
    emit.push({
      t: "lock.released",
      cellId,
      by: { userId: lock.userId, ts: now },
    })
    // Locks are per user; every socket of that user sitting in the cell
    // loses its focusedCell.
    for (const [connId, cur] of nextPresence) {
      if (cur.userId !== lock.userId || cur.focusedCell !== cellId) continue
      const cleared = clearFocusedPresence(cur, now)
      nextPresence.set(connId, cleared)
      emit.push(presenceDiff(cleared))
    }
  }
  return { locks: next, presence: nextPresence, emit }
}
