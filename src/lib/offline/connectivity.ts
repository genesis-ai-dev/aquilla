/**
 * Online/offline status (Phase 5 task 5) — reads the Rust-side connectivity
 * loop (`src-tauri/src/connectivity.rs`, started at app boot, polling
 * `https://api.aquilla.app` every 10s) instead of re-implementing polling on
 * the JS side. `get_connectivity` gives the current value on mount;
 * `connectivity://changed` pushes updates in between polls.
 */
import { useEffect, useState } from "react"
import { isTauriRuntime } from "./is-tauri"

interface ConnectivityChangedPayload {
  online: boolean
}

/** `null` outside Tauri, or before the first `get_connectivity` call resolves. */
export function useConnectivity(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null)

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    async function boot(): Promise<void> {
      // Dynamically imported so the plain browser SPA (which hits this
      // module's isTauriRuntime() check but never gets past it) never pulls
      // @tauri-apps/api into its bundle — same convention as the LiveStore
      // worker imports in store.ts.
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ])
      const initial = await invoke<boolean>("get_connectivity")
      if (cancelled) return
      setOnline(initial)
      unlisten = await listen<ConnectivityChangedPayload>("connectivity://changed", (event) => {
        setOnline(event.payload.online)
      })
      if (cancelled) unlisten?.()
    }
    // isTauriRuntime() already gates this to the real desktop shell, but a
    // stale/mocked window.__TAURI__ (tests) or a not-yet-ready IPC bridge
    // must not surface as an unhandled rejection — this hook degrades to
    // "unknown" (null) exactly like the not-Tauri case above.
    void boot().catch(() => {})

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return online
}
