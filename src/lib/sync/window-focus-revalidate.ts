// Shared "window regained focus" coordinator.
//
// Several read hooks (useCells, useCellsAuditStats, useCellValidators,
// useCellHistory, useStaleSourceCells, useProjectSettings, useActiveCellStore)
// revalidate when the tab comes back — the cheap drift mitigation for peer
// writes that landed while the socket was down or the tab was asleep. Each
// used to register its own `focus` + `visibilitychange` listener, so a single
// alt-tab fanned out into 6–7 concurrent requests (one of them a POST
// /link/sync), and a hidden→visible flip fired BOTH events back to back.
//
// This module owns the one DOM listener pair and decides WHEN a focus
// revalidation happens; subscribers still decide WHAT they revalidate.
//   - At most one wave per MIN_INTERVAL_MS (a focus + visibilitychange pair,
//     or a user clicking in and out of the window, collapses to one wave).
//   - A tab that was hidden for under SHORT_HIDE_MS is skipped entirely: a
//     quick peek at another tab misses nothing a live socket doesn't deliver.

const MIN_INTERVAL_MS = 5_000
const SHORT_HIDE_MS = 2_000
const PAIRED_FOCUS_GRACE_MS = 1_000

type Listener = () => void

const listeners = new Set<Listener>()
let attached = false
let lastFiredAt = -Infinity
let hiddenAt: number | null = null
let suppressUntil = -Infinity
let now: () => number = () => Date.now()

function fire(): void {
  const t = now()
  if (t < suppressUntil) return
  if (t - lastFiredAt < MIN_INTERVAL_MS) return
  lastFiredAt = t
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch (err) {
      console.warn("[window-focus-revalidate] listener threw:", err)
    }
  }
}

function onFocus(): void {
  // A focus that follows a hidden→visible flip is handled by onVisibility;
  // a focus while the document is hidden (e.g. devtools) is not a "return".
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return
  fire()
}

function onVisibility(): void {
  if (typeof document === "undefined") return
  if (document.visibilityState === "hidden") {
    hiddenAt = now()
    return
  }
  const wasHiddenFor = hiddenAt === null ? null : now() - hiddenAt
  hiddenAt = null
  if (wasHiddenFor !== null && wasHiddenFor < SHORT_HIDE_MS) {
    // The browser fires `focus` right after this; swallow that pair too.
    suppressUntil = now() + PAIRED_FOCUS_GRACE_MS
    return
  }
  fire()
}

function attach(): void {
  if (attached || typeof window === "undefined") return
  attached = true
  window.addEventListener("focus", onFocus)
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
  }
}

function detach(): void {
  if (!attached) return
  attached = false
  window.removeEventListener("focus", onFocus)
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility)
  }
}

/**
 * Run `listener` when the window regains focus / the tab becomes visible,
 * rate-limited across every subscriber in the tab. Returns an unsubscribe.
 */
export function subscribeWindowRegainedFocus(listener: Listener): () => void {
  listeners.add(listener)
  attach()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) detach()
  }
}

/** Test-only: clear the rate-limit window and listener set between tests. */
export function resetWindowFocusRevalidateForTests(options?: { now?: () => number }): void {
  listeners.clear()
  detach()
  lastFiredAt = -Infinity
  hiddenAt = null
  suppressUntil = -Infinity
  now = options?.now ?? (() => Date.now())
}
