/**
 * Online/offline status (Phase 5 task 5) — reads the Rust-side connectivity
 * loop (`src-tauri/src/connectivity.rs`, started at app boot, polling every
 * 10s) instead of re-implementing polling on the JS side. `get_connectivity`
 * gives the current value on mount; `connectivity://changed` pushes updates in
 * between polls.
 *
 * The Rust side does not know which backend this build talks to, so it probes
 * nothing until we hand it `AUTH_BASE` (see `ensureProbeUrl`). Hardcoding the
 * host there meant a dev build reported PRODUCTION's reachability — it would
 * say "online" while its own API was unreachable and nothing was syncing.
 */
import { useEffect, useState } from "react"
import { isTauriRuntime } from "./is-tauri"
import { AUTH_BASE } from "@/lib/frontier/auth"

interface ConnectivityChangedPayload {
  online: boolean
}

/**
 * Tell Rust what to probe. Memoized — every call site can await it cheaply.
 *
 * Exported as `startConnectivityProbe` and called from OfflineStoreProvider at
 * app boot, not just from `useConnectivity`: the only consumer of that hook is
 * ConnectivityStatusChip, which mounts in the editor, so relying on it alone
 * left connectivity Unknown everywhere else in the app.
 */
let probeUrlSent: Promise<void> | null = null
function ensureProbeUrl(): Promise<void> {
  probeUrlSent ??= (async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("set_connectivity_probe_url", { url: AUTH_BASE })
  })().catch(() => {
    // Let a later call retry rather than wedging connectivity as Unknown for
    // the life of the process (e.g. IPC bridge not ready yet).
    probeUrlSent = null
  })
  return probeUrlSent
}

/**
 * One-shot connectivity check for non-React call sites — no event
 * subscription, just the current value. `null` outside Tauri or if the IPC
 * bridge isn't ready. Used by the completion path (Phase 6) to decide whether
 * a chat/completion request should route to the local LLM proxy instead of
 * the hosted provider.
 */
export async function isOnline(): Promise<boolean | null> {
  if (!isTauriRuntime()) return null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await ensureProbeUrl()
    // `null` here is Rust's "no probe has completed yet", which means the same
    // thing to callers as the not-Tauri case: unknown.
    return (await invoke<boolean | null>("get_connectivity")) ?? null
  } catch {
    return null
  }
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
      await ensureProbeUrl()
      const initial = await invoke<boolean | null>("get_connectivity")
      if (cancelled) return
      // Stays null (chip hidden) until the first probe lands, rather than
      // asserting a state nothing has measured yet.
      setOnline(initial ?? null)
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

/** Desktop-only: begin probing the backend this build talks to. No-op on web. */
export function startConnectivityProbe(): void {
  if (!isTauriRuntime()) return
  void ensureProbeUrl()
}
