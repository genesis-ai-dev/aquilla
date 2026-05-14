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
 * The hook never makes assumptions about who wins; it reflects what the
 * server tells us via `lock.claimed` / `lock.released`. `claim()` flips
 * isHeld true optimistically; if the server says someone else holds it,
 * the next lock.claimed frame from the server flips us back.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { ProjectWsServerMessage, WsReconciler } from "@/lib/sync/ws-reconciler"

/** Default lease duration in ms; renewed at half-time. */
export const DEFAULT_LEASE_MS = 30_000

export interface LockHolder {
  userId: string
  ts: number
}

export interface UseFocusLockArgs {
  /** Project-scoped reconciler. `null` means no live session — claim() is a no-op. */
  reconciler: WsReconciler | null
  /** Cell to lock. `null` means no cell is focused. */
  cellId: string | null
  /** Current user's id (matches what the server stamps on `lock.claimed`). */
  currentUserId: string
  /** Lease duration; renewed every half-period. */
  leaseMs?: number
  /** Optional pass-through so observers can mirror lock state elsewhere. */
  onLockEvent?(msg: ProjectWsServerMessage): void
}

export interface UseFocusLockResult {
  /** True iff we believe this client holds the lock. */
  isHeld: boolean
  /** Present iff another client holds the lock for this cell. */
  heldBy: LockHolder | null
  /** Request the lock + start renewal. Safe to call repeatedly. */
  claim(): void
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
    cellId,
    currentUserId,
    leaseMs = DEFAULT_LEASE_MS,
    onLockEvent,
  } = args

  const [isHeld, setIsHeld] = useState(false)
  const [heldBy, setHeldBy] = useState<LockHolder | null>(null)
  const renewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const claimedCellRef = useRef<string | null>(null)
  const cellIdRef = useRef(cellId)
  const onLockEventRef = useRef(onLockEvent)

  useEffect(() => {
    cellIdRef.current = cellId
  }, [cellId])

  useEffect(() => {
    onLockEventRef.current = onLockEvent
  }, [onLockEvent])

  const stopRenewal = useCallback(() => {
    if (renewTimerRef.current !== null) {
      clearInterval(renewTimerRef.current)
      renewTimerRef.current = null
    }
  }, [])

  const claim = useCallback(() => {
    if (!reconciler || !cellId) return
    claimedCellRef.current = cellId
    setIsHeld(true)
    reconciler.send({ t: "focus.claim", cellId, leaseMs })
    stopRenewal()
    // Half-period renewal — a single dropped frame shouldn't expire the lease.
    renewTimerRef.current = setInterval(() => {
      const target = claimedCellRef.current
      if (!target) return
      reconciler.send({ t: "focus.renew", cellId: target })
    }, Math.max(1_000, Math.floor(leaseMs / 2)))
  }, [reconciler, cellId, leaseMs, stopRenewal])

  const release = useCallback(() => {
    stopRenewal()
    const target = claimedCellRef.current
    claimedCellRef.current = null
    setIsHeld(false)
    if (!reconciler || !target) return
    reconciler.send({ t: "focus.release", cellId: target })
  }, [reconciler, stopRenewal])

  // Auto-release when the focused cell changes — otherwise the previous
  // claim's renewal timer keeps firing against the wrong cell. The effect
  // synchronizes the *external* WS lease lifetime to the cellId prop;
  // setIsHeld inside release() is the only React state and it's reflecting
  // the WS state, not deriving new state from props.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (claimedCellRef.current && claimedCellRef.current !== cellId) {
      release()
    }
  }, [cellId, release])
  /* eslint-enable react-hooks/set-state-in-effect */

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
          setIsHeld(true)
          setHeldBy(null)
          return
        }
        setIsHeld(false)
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
    [currentUserId, stopRenewal],
  )

  return [{ isHeld, heldBy, claim, release }, feedFrame]
}
