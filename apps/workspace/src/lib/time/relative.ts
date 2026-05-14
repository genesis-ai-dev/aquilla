/**
 * Cheap, offline relative-time formatter for "last active 3 days ago" style
 * labels in the Members page. We don't need full localization or precision
 * — minute-precision is more than enough for a staleness indicator that
 * exists to flag "this person hasn't done anything in weeks."
 *
 * Returns null for null/undefined/invalid input so callers can render
 * "No recent activity" instead of "X ago" when no timestamp exists.
 */
export function formatRelativeTime(iso: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const diffSec = Math.max(0, Math.floor((nowMs - t) / 1000))
  if (diffSec < 60) return "just now"
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`
  const diffMonth = Math.floor(diffDay / 30)
  if (diffMonth < 12) return `${diffMonth} month${diffMonth === 1 ? "" : "s"} ago`
  const diffYear = Math.floor(diffDay / 365)
  return `${diffYear} year${diffYear === 1 ? "" : "s"} ago`
}

/**
 * Threshold for when a member is considered "stale" — used by the Roster
 * to color the relative-time chip in a way that draws the eye. 30 days is
 * intentionally conservative for translation projects, where someone might
 * legitimately work in bursts.
 */
export const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000

export function isStale(iso: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!iso) return false // "no activity yet" isn't the same as "stale"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  return nowMs - t > STALE_THRESHOLD_MS
}
