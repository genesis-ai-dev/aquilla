import { useEffect, useRef } from "react"
import { useAccounts } from "@/hooks/useAccounts"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { createOfflineSyncManager, type OfflineSyncManager } from "@/lib/offline/sync-manager"
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
    const mintToken = buildProjectAwareMinter(() => jwtRef.current)
    const manager: OfflineSyncManager = createOfflineSyncManager({ store, mintToken })
    return () => {
      manager.close()
    }
  }, [store])

  return null
}
