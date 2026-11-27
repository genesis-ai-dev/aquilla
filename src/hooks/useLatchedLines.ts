import { useMemo, useState } from "react"

/**
 * AQU-2711 x AQU-2253 (review, Nov 25): a list of lines fixed while something
 * is open (the recorder) and followed again once it closes. The ids are
 * latched when it opens; the lines are read from `live` on every render, so a
 * take recorded on one of them shows at once. A latched line `live` no longer
 * holds keeps its latched copy.
 */
export function useLatchedLines<T extends { id: string }>(open: boolean, current: T[], live: readonly T[]): T[] {
  const [latched, setLatched] = useState<T[] | null>(null)
  // Adjusted during render (React's pattern for state derived from a prop
  // change), so the first render while open already holds the latch.
  let held = latched
  if (open && latched == null) {
    held = current
    setLatched(current)
  } else if (!open && latched != null) {
    held = null
    setLatched(null)
  }
  return useMemo(() => {
    if (!held) return current
    const byId = new Map(live.map((c) => [c.id, c]))
    return held.map((c) => byId.get(c.id) ?? c)
  }, [held, current, live])
}
