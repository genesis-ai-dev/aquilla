import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { Store } from "@livestore/livestore"
import { getOfflineStore, isTauriRuntime } from "@/lib/offline/store"
import { startConnectivityProbe } from "@/lib/offline/connectivity"
import type { schema } from "@/lib/offline/schema"

export interface OfflineStoreContextValue {
  /** Null outside the Tauri desktop app, while the store is still booting, or if boot failed. */
  store: Store<typeof schema> | null
  loading: boolean
  error: Error | null
}

const defaultValue: OfflineStoreContextValue = { store: null, loading: false, error: null }

const OfflineStoreContext = createContext<OfflineStoreContextValue>(defaultValue)

/**
 * Boots the local LiveStore offline store (src/lib/offline/store.ts) once, on
 * mount, and makes it available to the rest of the app via useOfflineStore().
 * A no-op outside the Tauri desktop shell: isTauriRuntime() is false there,
 * so this never calls getOfflineStore() and every consumer just sees a null
 * store — the browser SPA keeps reading through sync-worker HTTP.
 */
export function OfflineStoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OfflineStoreContextValue>(() => ({
    store: null,
    loading: isTauriRuntime(),
    error: null,
  }))

  useEffect(() => {
    if (!isTauriRuntime()) return
    // Hand the Rust connectivity loop the API base this build talks to, so it
    // probes the right environment. Done from this app-wide Tauri bootstrap
    // rather than from ConnectivityStatusChip, which only mounts in the editor.
    startConnectivityProbe()
    let cancelled = false
    getOfflineStore()
      .then((store) => {
        if (!cancelled) setState({ store, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          store: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return <OfflineStoreContext.Provider value={state}>{children}</OfflineStoreContext.Provider>
}

export function useOfflineStore(): OfflineStoreContextValue {
  return useContext(OfflineStoreContext)
}
