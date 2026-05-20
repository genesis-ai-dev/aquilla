// AD-1: useFileSync is a legacy compatibility shim with no file-level CRDT
// transport.
//
// Pre-AD-1 this hook owned the file-scoped provider + awareness roster for
// the current file. Realtime coordination now lives on the project-scoped
// ProjectSync WebSocket; this hook remains only so older call sites can keep
// a stable sync status signal while they are migrated.
//
// It returns:
//   - `peers: []`     — peer roster comes back when Phase 2c rebuilds
//                       presence on the new WS event channel.
//   - `connected: true` — best-effort online state; the UI's "live" indicator
//                       continues to show green while we migrate.
//   - `provider: null` — no longer exposed. Callers that destructure this
//                       receive null; nothing on the production path
//                       dereferences it, but if you find one it should move
//                       onto the outbox API instead.
//   - `status: "live"`  — the SyncStatusIndicator-friendly state. Always
//                       "live" when the browser is online and the hook is
//                       enabled; "disabled" otherwise.
//
// The old options interface (doc, projectId, fileId, username, session, ...)
// is preserved so call sites keep type-checking unchanged.

import { useEffect, useState } from "react"
import type { FrontierSession } from "@/lib/frontier/types"
import type { SyncStatus } from "@/components/SyncStatusIndicator"

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

interface UseFileSyncOptions {
  doc: unknown | null
  projectId: string | null
  fileId: string | null
  username: string
  enabled: boolean
  session: FrontierSession | null
  projectName?: string | null
  gitlabProjectId?: number | null
}

export function useFileSync(options: UseFileSyncOptions): {
  peers: PeerState[]
  connected: boolean
  provider: null
  status: SyncStatus
} {
  const { enabled } = options
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

  const connected = enabled && online
  const status: SyncStatus = !enabled ? "disabled" : connected ? "live" : "connecting"
  return {
    peers: [],
    connected,
    provider: null,
    status,
  }
}
