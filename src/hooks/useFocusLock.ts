/**
 * Per-cell focus-lock client (Phase 2c-α).
 *
 * AD-1: when a translator focuses on a cell, the editor claims a short-lived
 * soft lock (lease ~30s, auto-renewed on activity, released on blur or
 * disconnect). Other collaborators see "Alice is editing this cell"
 * presence and a read-only view of the cell.
 *
 * This hook wraps a `WsReconciler` (provided by the caller, typically
 * scoped to the workspace) and exposes:
 *
 *   const [{ isHeld, heldBy, claim, release }, feedFrame] = useFocusLock({
 *     reconciler, cellId, currentUserId,
 *   })
 *
 *   isHeld    — true iff *this* client currently holds the lock.
 *   heldBy    — present when *another* client holds the lock; editor disables
 *               input and shows the "Alice is editing" banner.
 *   claim()   — call on focus. Sends focus.claim; starts the renewal timer.
 *   release() — call on blur/idle/save. Sends focus.release; stops renewal.
 *   feedFrame — call from the workspace WS bus for every server frame.
 *
 * Server policy:
 *   - A claim against an unheld cell wins; server broadcasts lock.claimed.
 *   - A claim against a held cell is silently ignored — the server stays
 *     authoritative and re-broadcasts the existing holder's lock.claimed.
 *   - Auto-expiry on disconnect / lease timeout fires lock.released.
 *
 * Only a server acknowledgement grants edit permission. Re-claims renew the
 * lease with an acknowledgement; transport loss or an expired local deadline
 * pauses input. Deadlines start when the request was sent, not when its delayed
 * response arrives. Presence alone never grants a local lease.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { ProjectWsServerMessage, WsReconciler } from "@/lib/sync/ws-reconciler"

/** Default lease duration in ms; renewed at half-time. */
export const DEFAULT_LEASE_MS = 30_000

/**
 * AQU-538: compose the DO focus-lock key from a cellId and an active lane.
 *
 * The project Durable Object treats the lock key as an OPAQUE string — it
 * never parses it. That lets us partition focus leases PER LANE entirely on
 * the client, with zero server changes: two translators editing the same
 * `cellId` in different target lanes compose different keys, so neither sees
 * the other as "editing", while two translators in the SAME lane still
 * contend on one lease exactly as before.
 *
 * The default lane (`''` / undefined) composes to the bare `cellId`, so with
 * no non-default lanes the key is byte-identical to the pre-lane behaviour —
 * N=1 back-compat is preserved on the wire and in presence snapshots.
 */
export function focusLockKey(cellId: string, lane: string | undefined): string {
  return lane ? `${cellId}@lane:${lane}` : cellId
}

export interface LockHolder {
  userId: string
  ts: number
}

export interface UseFocusLockArgs {
  /** Project-scoped reconciler. `null` means no live session — claim() is a no-op. */
  reconciler: WsReconciler | null
  /** Reactive transport state, supplied by the workspace on open/close. */
  connected?: boolean
  /** Cell to lock. `null` means no cell is focused. */
  cellId: string | null
  /**
   * AQU-538: the active target lane. Composed into the DO lock key via
   * {@link focusLockKey} so leases are per-lane. `''`/undefined = default
   * lane → the key is the bare cellId (byte-identical to pre-lane behaviour).
   */
  lane?: string
  /** Current user's id (matches what the server stamps on `lock.claimed`). */
  currentUserId: string
  /** Lease duration; renewed every half-period. */
  leaseMs?: number
  /** Optional pass-through so observers can mirror lock state elsewhere. */
  onLockEvent?(msg: ProjectWsServerMessage): void
}

export interface UseFocusLockResult {
  /** True only while a server-confirmed lease and transport are live. */
  isHeld: boolean
  /** Raw cell whose lease was acknowledged (never the previous focus). */
  heldCellId: string | null
  /** Present iff another client holds the lock for this cell. */
  heldBy: LockHolder | null
  /** Request the lock + start renewal. Safe to call repeatedly. */
  claim(cellIdOverride?: string): void
  /** Release the lock + stop renewal. Safe to call repeatedly. */
  release(): void
}

/**
 * Returns the public state + a `feedFrame(msg)` function that the caller
 * pumps every server frame through (typically from a workspace-level WS
 * message bus). Frames the hook doesn't care about are ignored.
 */
export function useFocusLock(
  args: UseFocusLockArgs,
): [UseFocusLockResult, (msg: ProjectWsServerMessage) => void] {
  const {
    reconciler,
    connected = reconciler?.isConnected() ?? false,
    cellId,
    lane,
    currentUserId,
    leaseMs = DEFAULT_LEASE_MS,
    onLockEvent,
  } = args

  // AQU-538: the composed lock key is what actually crosses the wire and what
  // every server frame (`lock.claimed`/`lock.released`/`presence.focusedCell`)
  // is compared against — never the bare cellId. For the default lane this is
  // exactly the cellId, so no on-wire behaviour changes with N=1.
  const lockKey = cellId != null ? focusLockKey(cellId, lane) : null

  const [isHeld, setIsHeld] = useState(false)
  const [heldCellId, setHeldCellId] = useState<string | null>(null)
  const confirmedCellRef = useRef<string | null>(null)
  const [heldBy, setHeldBy] = useState<LockHolder | null>(null)
  const renewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentAtRef = useRef<number | null>(null)
  const claimedCellRef = useRef<string | null>(null)
  // Holds the composed lock key for the currently-focused cell (see lockKey).
  const cellIdRef = useRef(lockKey)
  const onLockEventRef = useRef(onLockEvent)

  useEffect(() => {
    cellIdRef.current = lockKey
  }, [lockKey])

  useEffect(() => {
    onLockEventRef.current = onLockEvent
  }, [onLockEvent])

  const stopRenewal = useCallback(() => {
    if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current)
    expiryTimerRef.current = null
    sentAtRef.current = null
    if (renewTimerRef.current !== null) {
      clearInterval(renewTimerRef.current)
      renewTimerRef.current = null
    }
  }, [])

  const claim = useCallback((cellIdOverride?: string) => {
    // `cellIdOverride` is a RAW cellId (callers don't know the lane); compose
    // it into the lane-qualified key here so claim/renew/release all agree.
    const rawCellId = cellIdOverride ?? cellId
    const targetCellId = rawCellId != null ? focusLockKey(rawCellId, lane) : null
    if (!targetCellId) return
    // Repeated activation while the reply is in flight must not reset its
    // send timestamp or let an older acknowledgement extend the deadline.
    if (claimedCellRef.current === targetCellId && reconciler?.isConnected()
      && (confirmedCellRef.current === targetCellId || sentAtRef.current !== null)) return
    if (claimedCellRef.current && claimedCellRef.current !== targetCellId) {
      reconciler?.send({ t: "focus.release", cellId: claimedCellRef.current })
    }
    claimedCellRef.current = targetCellId
    cellIdRef.current = targetCellId
    confirmedCellRef.current = null
    setIsHeld(false)
    setHeldCellId(null)
    stopRenewal()
    sentAtRef.current = Date.now()
    if (!reconciler?.send({ t: "focus.claim", cellId: targetCellId, leaseMs })) {
      sentAtRef.current = null
      return
    }
    // Half-period renewal — a single dropped frame shouldn't expire the lease.
    renewTimerRef.current = setInterval(() => {
      const target = claimedCellRef.current
      if (!target) return
      // Re-claim also gets an acknowledgement on older workers. Merely
      // queueing a renewal frame is not evidence that a lease still exists.
      if (sentAtRef.current !== null) {
        if (Date.now() - sentAtRef.current < leaseMs) return
        // Do not mistake an expired reply for a later claim's acknowledgement.
        confirmedCellRef.current = null
        setIsHeld(false)
        setHeldCellId(null)
        stopRenewal()
        reconciler.reconnect()
        return
      }
      sentAtRef.current = Date.now()
      if (!reconciler.send({ t: "focus.claim", cellId: target, leaseMs })) {
        confirmedCellRef.current = null
        setIsHeld(false)
        setHeldCellId(null)
        stopRenewal()
      }
    }, Math.max(1_000, Math.floor(leaseMs / 2)))
  }, [reconciler, cellId, lane, leaseMs, stopRenewal])

  const release = useCallback(() => {
    stopRenewal()
    const target = claimedCellRef.current
    claimedCellRef.current = null
    confirmedCellRef.current = null
    setIsHeld(false)
    setHeldCellId(null)
    if (!reconciler || !target) return
    reconciler.send({ t: "focus.release", cellId: target })
  }, [reconciler, stopRenewal])

  // Transport loss immediately revokes edit permission. Keep the requested
  // cell so reconnect can reacquire it, but require a fresh server response.
  useEffect(() => {
    if (!connected) {
      confirmedCellRef.current = null
      setIsHeld(false)
      setHeldCellId(null)
      stopRenewal()
    } else if (claimedCellRef.current) {
      claim(cellId ?? undefined)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, reconciler])

  // Auto-release when the focused cell changes — otherwise the previous
  // claim's renewal timer keeps firing against the wrong cell. The effect
  // synchronizes the *external* WS lease lifetime to the cellId prop;
  // setIsHeld inside release() is the only React state and it's reflecting
  // the WS state, not deriving new state from props.
  useEffect(() => {
    // Compare against the composed key: switching cell OR lane must release
    // the prior lease (otherwise the renewal timer keeps firing the old key).
    if (claimedCellRef.current && claimedCellRef.current !== lockKey) {
      release()
    }
  }, [lockKey, release])

  // Drop the lock on unmount so a refresh or navigate-away doesn't strand a
  // lease (would otherwise wait for leaseMs to auto-expire).
  useEffect(() => {
    return () => {
      release()
    }
  }, [release])

  const feedFrame = useCallback(
    (msg: ProjectWsServerMessage) => {
      onLockEventRef.current?.(msg)
      const cur = cellIdRef.current
      if (!cur) return

      if (msg.t === "lock.claimed") {
        if (msg.cellId !== cur) return
        if (msg.by.userId === currentUserId) {
          // Ignore our delayed echo after blur / switching cells.
          if (claimedCellRef.current !== cur || !reconciler?.isConnected()) return
          if (sentAtRef.current === null) return
          // Start the deadline at SEND, not receipt: a delayed acknowledgement
          // must not grant an extra lease's worth of editing time on this client.
          const remaining = sentAtRef.current + leaseMs - Date.now()
          sentAtRef.current = null
          if (remaining <= 0) return
          if (expiryTimerRef.current !== null) clearTimeout(expiryTimerRef.current)
          expiryTimerRef.current = setTimeout(() => {
            confirmedCellRef.current = null
            setIsHeld(false)
            setHeldCellId(null)
          }, remaining)
          confirmedCellRef.current = cur
          setIsHeld(true)
          setHeldCellId(lane ? cur.slice(0, -(`@lane:${lane}`).length) : cur)
          setHeldBy(null)
          return
        }
        setIsHeld(false)
        confirmedCellRef.current = null
        setHeldCellId(null)
        setHeldBy({ userId: msg.by.userId, ts: msg.by.ts })
        if (claimedCellRef.current === cur) {
          claimedCellRef.current = null
          stopRenewal()
        }
        return
      }

      if (msg.t === "lock.released") {
        if (msg.cellId !== cur) return
        setHeldBy((c) => (c && c.userId === msg.by.userId ? null : c))
        if (msg.by.userId === currentUserId) {
          setIsHeld(false)
          confirmedCellRef.current = null
          setHeldCellId(null)
          if (claimedCellRef.current === cur) {
            claimedCellRef.current = null
            stopRenewal()
          }
        }
        return
      }

      // presence-snapshot reconciliation: post-reconnect, the server replays
      // the current roster. If someone else reports this cell focused, treat
      // it as an implicit lock.claimed; if no one does, clear stale heldBy.
      if (msg.t === "presence") {
        for (const u of msg.users) {
          if (u.focusedCell !== cur) continue
          if (u.userId === currentUserId) continue
          setIsHeld(false)
          confirmedCellRef.current = null
          setHeldCellId(null)
          setHeldBy({ userId: u.userId, ts: u.ts })
          if (claimedCellRef.current === cur) {
            claimedCellRef.current = null
            stopRenewal()
          }
          return
        }
        setHeldBy((c) => (c ? null : c))
        return
      }
    },
    [currentUserId, stopRenewal, reconciler, lane, leaseMs],
  )

  return [{ isHeld: isHeld && connected, heldCellId, heldBy, claim, release }, feedFrame]
}
