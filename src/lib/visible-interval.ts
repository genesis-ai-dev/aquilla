/**
 * `setInterval` for polling a server on behalf of someone who is looking
 * (AQU-2654).
 *
 * A poll that keeps running in a hidden tab spends requests, and a commit per
 * answer, on a screen nobody can see — per card, for as long as the tab stays
 * open. This skips every tick while the document is hidden and, if it skipped
 * any, runs once the moment the tab is shown again, so what the user comes
 * back to is at most one round trip old rather than one interval old.
 *
 * Returns the stop function. Not for timers that drive local state (a clock, a
 * recorder's elapsed time): those have nothing to save by pausing.
 */
export function startVisibleInterval(tick: () => void, intervalMs: number): () => void {
  let missed = false
  const timer = setInterval(() => {
    if (document.visibilityState === "hidden") {
      missed = true
      return
    }
    tick()
  }, intervalMs)
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden" || !missed) return
    missed = false
    tick()
  }
  document.addEventListener("visibilitychange", onVisibilityChange)
  return () => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", onVisibilityChange)
  }
}
