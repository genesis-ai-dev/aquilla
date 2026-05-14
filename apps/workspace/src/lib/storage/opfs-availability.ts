// Tracks whether OPFS (Origin Private File System) is usable in the current
// browsing context. Set by the cache layers the first time
// `navigator.storage.getDirectory()` throws — most commonly Safari Private
// Browsing, but also Brave Tor windows and any context where storage is
// restricted. The UI subscribes via `useOpfsAvailability` to surface a one-time
// banner so users understand why audio waveforms / LFS aren't being cached.

type Listener = (available: boolean) => void

let _available = true
const listeners = new Set<Listener>()

export function markOpfsUnavailable(): void {
  if (!_available) return
  _available = false
  for (const fn of listeners) fn(false)
}

export function isOpfsAvailable(): boolean {
  return _available
}

export function subscribeOpfsAvailability(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

let probePromise: Promise<boolean> | null = null

/** Probes OPFS once and marks unavailable if the call throws. Safe to call on
 *  every render — the work is memoised. */
export function probeOpfsAvailability(): Promise<boolean> {
  if (probePromise) return probePromise
  probePromise = (async () => {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      markOpfsUnavailable()
      return false
    }
    try {
      await navigator.storage.getDirectory()
      return true
    } catch {
      markOpfsUnavailable()
      return false
    }
  })()
  return probePromise
}

/** Test seam — reset back to "available" between tests. */
export function __resetOpfsAvailabilityForTests(): void {
  _available = true
  listeners.clear()
  probePromise = null
}
