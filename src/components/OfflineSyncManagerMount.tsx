import { useEffect, useRef } from "react"
import { useAccounts } from "@/hooks/useAccounts"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { createOfflineSyncManager, type OfflineSyncManager } from "@/lib/offline/sync-manager"
import { recoverInterruptedDownloads } from "@/lib/offline/download"
import { whenOfflineStoreVerified } from "@/lib/offline/store"
import { buildProjectAwareMinter } from "@/lib/sync/cqrs-bridge"

/**
 * Invisible mount point (Phase 3) that starts the offline sync manager once
 * the local LiveStore store has booted. A no-op outside the Tauri desktop
 * shell: `useOfflineStore()` only ever resolves a `store` there (see
 * OfflineStoreContext.tsx), so this effect never fires in the browser SPA.
 *
 * Rendered inside <OfflineStoreProvider> in App.tsx, alongside the other
 * invisible app-wide mounts (PrivateModeBanner, SessionExpiredBanner, …).
 */
export function OfflineSyncManagerMount(): null {
  const { store } = useOfflineStore()
  const { active } = useAccounts()

  // A ref, not a dependency: session-refresh rotates the JWT every few
  // minutes (useSessionRefresh), and recreating the manager on every rotation
  // would tear down and reopen every open project's WebSocket for no reason.
  // mintToken only needs the LATEST jwt at call time, same as ProjectWorkspace's
  // own jwtRef pattern.
  const jwtRef = useRef<string | null>(active?.jwt ?? null)
  useEffect(() => {
    jwtRef.current = active?.jwt ?? null
  }, [active?.jwt])

  useEffect(() => {
    if (!store) return
    let cancelled = false
    // Deletes local rows, so it only runs once the leader has confirmed what
    // this session reads: a store handed out after a head-check timeout may
    // still be catching up, and an older status (`downloading`) read from it
    // once cost a healthy project its whole local copy. A download the user
    // starts before then is skipped as live (see recoverInterruptedDownloads).
    void whenOfflineStoreVerified().then(() => {
      if (cancelled) return
      const recovered = recoverInterruptedDownloads(store)
      if (recovered.length > 0) console.warn("[offline] rolled back interrupted downloads", recovered)
    })
    const mintToken = buildProjectAwareMinter(() => jwtRef.current)
    const manager: OfflineSyncManager = createOfflineSyncManager({ store, mintToken })
    return () => {
      cancelled = true
      manager.close()
    }
  }, [store])

  return null
}
