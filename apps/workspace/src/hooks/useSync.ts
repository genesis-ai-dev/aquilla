// Minimal WS connection state for the sync-worker DO (Phase 2b).
//
// Pre-Phase 2b the prototype's `useSync` wrapped `y-webrtc` for P2P sharing.
// Aquilla's v1 data flow goes through Cloudflare instead (per AD-1 / AD-3):
// the sync-worker hosts a Durable Object per file, clients open a WS, the
// reconciler walks the outbox. The full reconciler is Phase 2c — for now
// this hook reports a static "connected" state derived from `navigator.onLine`
// so the UI's sync indicator doesn't render permanently red while the
// reconciler is being built.

import { useEffect, useState } from "react"

export interface UseSyncOptions {
  /** Disable when no project is open / no identity. */
  enabled?: boolean
}

export interface UseSyncResult {
  /** Best-effort "is the browser online". Phase 2c replaces this with the
   *  real WS connection state and an outbox-aware reconciler.flushing flag. */
  connected: boolean
}

/**
 * Phase 2b stub. Returns `connected = true` when the browser is online and
 * the hook is enabled; otherwise `false`. The full WS-backed implementation
 * with reconciler, presence, and focus locks lands in Phase 2c.
 *
 * No room joining, no awareness, no peer enumeration. Components that
 * previously rendered peer chips off `useSync` now render an empty roster
 * — same default they showed before any peer connected.
 */
export function useSync(opts: UseSyncOptions = {}): UseSyncResult {
  const { enabled = true } = opts
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
  return { connected: enabled && online }
}
