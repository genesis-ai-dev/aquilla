import { useEffect, useRef, useState } from "react"

export type LivenessState = "live" | "updating" | "indexing" | "offline"

/** Flash window after a Yjs update during which we show "updating". */
const UPDATING_WINDOW_MS = 800

export function deriveLivenessState(input: {
  online: boolean
  lastUpdate: number | null
  now: number
}): LivenessState {
  if (!input.online) return "offline"
  if (input.lastUpdate != null && input.now - input.lastUpdate < UPDATING_WINDOW_MS) {
    return "updating"
  }
  return "live"
}

export function formatSyncedAgo(input: {
  lastUpdate: number | null
  now: number
}): string {
  if (input.lastUpdate == null) return ""
  const delta = input.now - input.lastUpdate
  if (delta < 5_000) return "just now"
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  return `${Math.floor(delta / 3600_000)}h ago`
}

/**
 * Track liveness for the current project. v1 uses:
 *  - `navigator.onLine` + window online/offline events for offline detection
 *  - a caller-provided `bumpedAt` counter that advances whenever upstream
 *    state changes (e.g., project or rules identity change) as the proxy
 *    for "we just received an update"
 *
 * When the y-sweet provider's sync events are exposed project-wide, swap
 * `bumpedAt` for a subscription to those events. The pure state derivation
 * above does not change.
 */
export function useLiveness(bumpedAt: number): {
  state: LivenessState
  label: string
} {
  const [online, setOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  )
  const [now, setNow] = useState(() => Date.now())

  // Track the latest bump timestamp so we can compute "X seconds ago."
  const lastUpdateRef = useRef<number | null>(null)
  useEffect(() => {
    if (bumpedAt > 0) {
      lastUpdateRef.current = Date.now()
      setNow(Date.now()) // force re-evaluation for immediate flash
    }
  }, [bumpedAt])

  // Tick once per second while mounted so "X seconds ago" updates and
  // the UPDATING_WINDOW transition fires.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Offline/online listeners
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])

  const state = deriveLivenessState({
    online,
    lastUpdate: lastUpdateRef.current,
    now,
  })

  const agoLabel = formatSyncedAgo({ lastUpdate: lastUpdateRef.current, now })

  let label: string
  switch (state) {
    case "offline":
      label = "Offline"
      break
    case "updating":
      label = "Updating…"
      break
    case "indexing":
      label = "Indexing…"
      break
    case "live":
      label = agoLabel ? `Live · synced ${agoLabel}` : "Live"
      break
  }

  return { state, label }
}
