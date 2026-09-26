import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useUnsyncedOfflineWorkGuard } from "@/lib/offline/unsynced-guard"

/**
 * Invisible mount point that warns before a reload/close whenever the local
 * offline store has writes that haven't reached the server yet. A no-op
 * outside the Tauri desktop shell — `useOfflineStore()` only ever resolves a
 * `store` there (see OfflineStoreContext.tsx).
 *
 * Rendered inside <OfflineStoreProvider> in App.tsx, alongside
 * OfflineSyncManagerMount.
 */
export function UnsyncedOfflineWorkGuard(): null {
  const { store } = useOfflineStore()
  useUnsyncedOfflineWorkGuard(store)
  return null
}
