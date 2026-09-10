// AD-1: useFileSync feeds the workspace sync-status pill. There is no
// file-level CRDT transport any more; realtime coordination lives on the
// project-scoped ProjectSync WebSocket and writes go through the outbox.
//
// AQU-1155: the pill must report distance from truth, so `status` is a pure
// function of the real signals (`deriveSyncStatus`) rather than a best-effort
// "green while online" guess:
//   - navigator.onLine            → "offline" when false
//   - project WS reconciler       → "reconnecting" while the socket is not OPEN
//   - outbox pending/failureStreak → "retrying" once a drain has failed,
//                                    "syncing" while records are still queued
//   - everything clear            → "live"
//
// It still returns the legacy shape (`peers: []`, `provider: null`) so older
// call sites keep type-checking unchanged; the old options (doc, fileId, …)
// are accepted and ignored.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import type { FrontierSession } from "@/lib/frontier/types"
import type { SyncStatus } from "@/components/SyncStatusIndicator"
import type { WsReconciler } from "@/lib/sync/ws-reconciler"

/** Awareness payload for a single connected peer in a project-sync room.
 *  Phase 2b leaves the type intact for compile-time stability; the runtime
 *  list is always empty until Phase 2c. */
export interface PeerState {
  peerId: string
  username: string
  color: string
  currentFileId?: string
}

/**
 * Deterministic color from a peerId for avatar tinting. Pure; kept around
 * so non-sync callers (e.g. UserBadge) still resolve a stable color from
 * a known user id.
 */
export function peerColor(peerId: string): string {
  let hash = 0
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash << 5) - hash + peerId.charCodeAt(i)
    hash |= 0
  }
  const colors = [
    "#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#f97316",
    "#14b8a6", "#eab308", "#ec4899", "#6366f1", "#84cc16",
  ]
  return colors[Math.abs(hash) % colors.length]
}

export interface SyncSignals {
  /** False when there is no project/file to sync (pill reads "No file open"). */
  enabled: boolean
  /** navigator.onLine. */
  online: boolean
  /** Project WS reconciler socket is OPEN. */
  socketOpen: boolean
  /** Outbox records still waiting to be accepted by the server. */
  pendingCount: number
  /** Consecutive outbox drain cycles that accepted nothing. */
  failureStreak: number
}

/**
 * Pure. Precedence, most-distant-from-truth first:
 *   disabled → offline → retrying → reconnecting → syncing → live
 * "retrying" outranks "reconnecting" because a failing outbox means the
 * user's own edits are not landing, which matters more than a closed socket
 * (the outbox drains over HTTP regardless of the socket).
 */
export function deriveSyncStatus(s: SyncSignals): SyncStatus {
  if (!s.enabled) return "disabled"
  if (!s.online) return "offline"
  if (s.pendingCount > 0 && s.failureStreak >= 1) return "retrying"
  if (!s.socketOpen) return "reconnecting"
  if (s.pendingCount > 0) return "syncing"
  return "live"
}

/** The reconciler exposes `isConnected()` but no change callback the
 *  workspace can subscribe to from here, so the hook samples it. */
const SOCKET_POLL_MS = 1000

interface UseFileSyncOptions {
  doc: unknown | null
  projectId: string | null
  fileId: string | null
  username: string
  enabled: boolean
  session: FrontierSession | null
  projectName?: string | null
  gitlabProjectId?: number | null
  /** Project WS reconciler; null until connected the first time. Omitted →
   *  treated as not open. */
  reconciler?: Pick<WsReconciler, "isConnected"> | null
  /** Outbox signals from OutboxContext. Omitted → treated as empty/healthy. */
  pendingCount?: number
  failureStreak?: number
}

export function useFileSync(options: UseFileSyncOptions): {
  peers: PeerState[]
  connected: boolean
  provider: null
  status: SyncStatus
} {
  const { enabled, reconciler = null, pendingCount = 0, failureStreak = 0 } = options
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  )
  useEffect(() => {
    if (typeof window === "undefined") return
    function on() { setOnline(true) }
    function off() { setOnline(false) }
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])

  const subscribeSocket = useCallback(
    (onChange: () => void) => {
      if (!reconciler) return () => {}
      const timer = setInterval(onChange, SOCKET_POLL_MS)
      return () => clearInterval(timer)
    },
    [reconciler],
  )
  const socketOpen = useSyncExternalStore(
    subscribeSocket,
    () => (enabled && reconciler ? reconciler.isConnected() : false),
    () => false,
  )

  const status = deriveSyncStatus({ enabled, online, socketOpen, pendingCount, failureStreak })
  return {
    peers: [],
    connected: enabled && online && socketOpen,
    provider: null,
    status,
  }
}
