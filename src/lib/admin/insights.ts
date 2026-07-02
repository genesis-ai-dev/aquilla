// Pure, presentation-only derivations for the admin console's operator home.
// These take data the console already fetches (AdminProject/Org/User/Activity)
// and turn it into "what needs a platform operator's attention" — no new API
// calls, no worker changes. Deterministic (callers pass `now`) so it unit-tests
// cleanly. Deadline semantics mirror src/lib/frontier/portfolio.ts (AoE grace).

import type { AdminProject, AdminOrg, AdminUser } from "@/lib/frontier/admin"

const DAY_MS = 24 * 60 * 60 * 1000
/** No target edit in this long ⇒ "stalled". Matches the org portfolio's 14d. */
const STALE_MS = 14 * DAY_MS
/** "Anywhere on Earth": a date isn't overdue until it has ended in UTC-12. */
const AOE_GRACE_MS = (24 + 12) * 60 * 60 * 1000
const SOON_MS = 7 * DAY_MS

/** Validated fraction 0..1 (0 when the project has no cells). */
export function validatedFraction(p: Pick<AdminProject, "totalCells" | "validatedCells">): number {
  return p.totalCells > 0 ? p.validatedCells / p.totalCells : 0
}

export type DeadlineState = "overdue" | "soon" | "ok"

/** null when no (or unparseable) deadline; else overdue / soon (≤7d) / ok. */
export function deadlineState(p: Pick<AdminProject, "deadlineAt">, now: number): DeadlineState | null {
  if (!p.deadlineAt) return null
  const t = Date.parse(p.deadlineAt) // "YYYY-MM-DD" → UTC midnight
  if (Number.isNaN(t)) return null
  if (now >= t + AOE_GRACE_MS) return "overdue"
  if (t + AOE_GRACE_MS - now <= SOON_MS) return "soon"
  return "ok"
}

/** True when the project has content but hasn't been edited in STALE_MS. */
export function isStalled(p: Pick<AdminProject, "totalCells" | "lastEditAt">, now: number): boolean {
  if (p.totalCells <= 0) return false // an empty shell isn't "stalled", it's unstarted
  if (p.lastEditAt == null) return true // has cells, never edited → stalled
  return now - p.lastEditAt > STALE_MS
}

export type AttentionKind = "overdue" | "soon" | "stalled"
export interface AttentionReason {
  kind: AttentionKind
  label: string
}

/**
 * Why a project needs attention, most-urgent first. Empty ⇒ healthy. Archived
 * projects are never at risk (callers still filter, but we guard here too).
 */
export function attentionReasons(p: AdminProject, now: number): AttentionReason[] {
  if (p.archived) return []
  const reasons: AttentionReason[] = []
  const dl = deadlineState(p, now)
  if (dl === "overdue") reasons.push({ kind: "overdue", label: "Overdue" })
  else if (dl === "soon") reasons.push({ kind: "soon", label: "Due soon" })
  if (isStalled(p, now)) reasons.push({ kind: "stalled", label: "Stalled" })
  return reasons
}

/** Higher = more urgent. Overdue ≫ due-soon ≫ stalled, then least-validated. */
export function attentionScore(p: AdminProject, now: number): number {
  const dl = deadlineState(p, now)
  const overdue = dl === "overdue" ? 1 : 0
  const soon = dl === "soon" ? 1 : 0
  const stalled = isStalled(p, now) ? 1 : 0
  // A bigger body of work at risk matters more (capped so it stays a tiebreak).
  const weight = Math.min(p.wordCount / 10_000, 1)
  return overdue * 3000 + soon * 1500 + stalled * 1000 + (1 - validatedFraction(p)) * 100 + weight * 50
}

export interface RankedProject {
  project: AdminProject
  reasons: AttentionReason[]
  score: number
}

/**
 * Active projects that are overdue, due soon, or stalled — ranked by urgency.
 * `limit` caps the list for the Overview home (omit for the full set).
 */
export function projectsNeedingAttention(
  projects: AdminProject[],
  now: number,
  limit?: number,
): RankedProject[] {
  const ranked = projects
    .filter((p) => !p.archived)
    .map((project) => ({ project, reasons: attentionReasons(project, now), score: attentionScore(project, now) }))
    .filter((r) => r.reasons.length > 0)
    .sort((a, b) => b.score - a.score)
  return limit == null ? ranked : ranked.slice(0, limit)
}

/** Orgs with the most projects (members break ties) — the busiest tenants. */
export function mostActiveOrgs(orgs: AdminOrg[], limit = 5): AdminOrg[] {
  return [...orgs]
    .sort((a, b) => b.projectCount - a.projectCount || b.memberCount - a.memberCount)
    .slice(0, limit)
}

/** How many users joined within the last `windowDays` (default 7). */
export function recentSignupCount(users: AdminUser[], now: number, windowDays = 7): number {
  const cutoff = now - windowDays * DAY_MS
  return users.reduce((n, u) => {
    const t = Date.parse(u.createdAt)
    return !Number.isNaN(t) && t >= cutoff ? n + 1 : n
  }, 0)
}

/** Most-recently-joined users first, capped at `limit`. */
export function newestUsers(users: AdminUser[], limit = 5): AdminUser[] {
  return [...users]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, limit)
}
