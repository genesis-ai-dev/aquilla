import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"

export interface PortfolioProject {
  id: string
  name: string
  totalCells: number
  validatedCells: number
  /** Target cells with content: the "translated" count (distinct from validated). */
  filledCells: number
  lastEditAt: number | null
  audioCells: number
  recordedMs: number
  deadlineAt: string | null
}

export async function getPortfolio(jwt: string, orgId: number): Promise<PortfolioProject[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/portfolio`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new Error(`getPortfolio failed: HTTP ${res.status}`)
  return ((await res.json()) as { projects: PortfolioProject[] }).projects
}

/** validated fraction 0..1 (0 when no cells). */
export function validatedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.validatedCells / p.totalCells : 0
}

/** translated (has-content) fraction 0..1 (0 when no cells). */
export function translatedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.filledCells / p.totalCells : 0
}

/** fraction of cells that have audio, 0..1 (0 when no cells). */
export function audioPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.audioCells / p.totalCells : 0
}

/** total recorded minutes (selected live clips), rounded. */
export function recordedMinutes(p: PortfolioProject): number {
  return Math.round(p.recordedMs / 60000)
}

export type DeadlineStatus = "overdue" | "soon" | "ok"

/**
 * Convention: "Anywhere on Earth" (AoE) deadline semantics.
 *
 * A deadline of "YYYY-MM-DD" is NOT overdue until that calendar day has ended
 * everywhere on Earth, including UTC-12 (Baker Island / Howland Island).
 * UTC-12 is 12 hours behind UTC, so end-of-day UTC-12 = next calendar day at
 * 12:00:00 UTC. We add a 1-day + 12-hour grace past the deadline date's UTC
 * midnight:  overdue when now_utc >= deadline_utc_midnight + 36 hours.
 *
 * This ensures:
 *   - A project due TODAY is never "overdue" during that calendar day anywhere.
 *   - A project due YESTERDAY is always "overdue" (more than 36h has passed).
 */
function isDeadlineOverdue(deadlineUtcMidnight: number, nowMs: number): boolean {
  const AOE_GRACE_MS = (24 + 12) * 60 * 60 * 1000 // 36 hours
  return nowMs >= deadlineUtcMidnight + AOE_GRACE_MS
}

/** null when no deadline; "overdue" past due; "soon" within 7 days; else "ok". */
export function deadlineStatus(p: PortfolioProject, now: number): DeadlineStatus | null {
  if (!p.deadlineAt) return null
  const t = Date.parse(p.deadlineAt) // "YYYY-MM-DD" → UTC midnight of that date
  if (Number.isNaN(t)) return null
  if (isDeadlineOverdue(t, now)) return "overdue"
  // "soon": within 7 days, measured from AoE end-of-deadline-day to now
  if (t + (24 + 12) * 60 * 60 * 1000 - now <= 7 * 24 * 60 * 60 * 1000) return "soon"
  return "ok"
}

/** Attention score: higher = more attention needed. Overdue ranks above stalled, which ranks above low completion. */
export function attentionRank(p: PortfolioProject, now: number): number {
  const ageMs = p.lastEditAt != null ? now - p.lastEditAt : Infinity
  const stale = ageMs > 14 * 24 * 60 * 60 * 1000 ? 1 : 0
  const overdue = deadlineStatus(p, now) === "overdue" ? 1 : 0
  return overdue * 2000 + stale * 1000 + (1 - validatedPct(p)) * 100
}
