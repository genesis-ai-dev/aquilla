import { useEffect, useRef } from "react"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { shutdownOfflineStoreGracefully } from "@/lib/offline/shutdown"

const PREPARE_SHUTDOWN_EVENT = "offline://prepare-shutdown"
const CONFIRM_SHUTDOWN_COMMAND = "confirm_offline_shutdown"

/**
 * Invisible mount: the JS side of the graceful-shutdown handshake with
 * src-tauri/src/shutdown_guard.rs. Rust prevents the real window
 * close/app quit and emits `offline://prepare-shutdown`, then holds up
 * exiting until either this confirms or 6s elapse. On receipt, flushes the
 * offline store's pending writes to the leader (see shutdown.ts for why
 * that can't be skipped) before telling Rust it's safe to actually exit.
 *
 * A no-op outside the Tauri desktop shell — the event never fires there
 * since there's no Rust backend to emit it.
 *
 * Rendered inside <OfflineStoreProvider> in App.tsx, alongside the other
 * invisible offline mounts.
 */
export function OfflineShutdownGuard(): null {
  const { store } = useOfflineStore()
  const storeRef = useRef(store)
  useEffect(() => {
    storeRef.current = store
  }, [store])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    void (async () => {
      // Dynamically imported so the browser SPA never pulls @tauri-apps/api
      // into its bundle — same convention as connectivity.ts/store.ts.
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ])
      if (cancelled) return
      unlisten = await listen(PREPARE_SHUTDOWN_EVENT, () => {
        void (async () => {
          const current = storeRef.current
          if (current) {
            await shutdownOfflineStoreGracefully(current).catch(() => {
              // Best-effort — Rust's own 6s timeout is the real backstop,
              // so a failed flush here still must not hang the confirm.
            })
          }
          await invoke(CONFIRM_SHUTDOWN_COMMAND).catch(() => {})
        })()
      })
      if (cancelled) unlisten?.()
    })().catch(() => {
      // Not-yet-ready IPC bridge (or a mocked isTauriRuntime() in tests) —
      // Rust's timeout still fires and exits normally, just without a clean
      // flush, same degradation as the pre-fix behavior.
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return null
}
