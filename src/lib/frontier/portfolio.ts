import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"
import { UserError } from "@/lib/errors/user-error"

export interface PortfolioProject {
  id: string
  name: string
  totalCells: number
  validatedCells: number
  /** Target cells with content: the "translated" count (distinct from validated). */
  filledCells: number
  /**
   * FRO-292: target cells that were machine-drafted (AI completion path) and have
   * not yet been human-edited or validated. 0 for projects predating this marker —
   * historical AI commits are indistinguishable from human edits (forward-only).
   */
  aiDraftedCells: number
  lastEditAt: number | null
  audioCells: number
  /**
   * AQU-508: cells whose selected audio take has been validated by a reviewer —
   * distinct from `audioCells` (coverage). 0 for projects with no audio
   * validations yet. Lets the Overview show audio-validation % separately from
   * text-validation % (AQU-490).
   */
  validatedAudioCells: number
  recordedMs: number
  deadlineAt: string | null
  /**
   * AQU-523: the project's source/target language, surfaced on the org /
   * all-orgs project list so the pair is visible at a glance (the
   * single-project overview already shows it). Null when unset — the server
   * normalizes the empty-settings default to null so the client never renders
   * a blank/broken "→".
   */
  sourceLanguage: string | null
  targetLanguage: string | null
}

/**
 * AQU-523: format a project's language pair for display, e.g. "Greek → Bambara".
 * Trims and treats empty strings as unset. Returns just the one known language
 * when only one side is set, and null when neither is — callers render nothing
 * in that case rather than a broken "→" or empty label.
 */
export function languagePairLabel(p: {
  sourceLanguage?: string | null
  targetLanguage?: string | null
}): string | null {
  const source = p.sourceLanguage?.trim() || null
  const target = p.targetLanguage?.trim() || null
  if (source && target) return `${source} → ${target}`
  return target ?? source ?? null
}

export interface OrgPortfolio {
  orgId: number
  projects: PortfolioProject[]
}

export async function getPortfolio(jwt: string, orgId: number): Promise<PortfolioProject[]> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/portfolio`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new UserError(res.status, "", "org")
  return ((await res.json()) as { projects: PortfolioProject[] }).projects
}

export async function getPortfolios(jwt: string, orgIds: number[]): Promise<OrgPortfolio[]> {
  const uniqueOrgIds = [...new Set(orgIds)].filter((id) => Number.isInteger(id) && id > 0)
  if (uniqueOrgIds.length === 0) return []
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/portfolio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ orgIds: uniqueOrgIds }),
  })
  if (!res.ok) throw new UserError(res.status, "", "org")
  return ((await res.json()) as { portfolios: OrgPortfolio[] }).portfolios
}

/** validated fraction 0..1 (0 when no cells). */
export function validatedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.validatedCells / p.totalCells : 0
}

/** translated (has-content) fraction 0..1 (0 when no cells). */
export function translatedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.filledCells / p.totalCells : 0
}

/**
 * FRO-292: fraction of cells that are AI-drafted and awaiting human review, 0..1.
 * 0 for projects that predate the provenance marker (forward-only, honest).
 */
export function aiDraftedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.aiDraftedCells / p.totalCells : 0
}

/** fraction of cells that have audio, 0..1 (0 when no cells). */
export function audioPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.audioCells / p.totalCells : 0
}

/**
 * AQU-508: fraction of audio-covered cells whose selected take is validated,
 * 0..1 (0 when no cells have audio). Denominator is `audioCells`, not
 * `totalCells`, so this reads as "how much of the recorded audio is validated"
 * — the audio analogue of validated-of-translated, and meaningful only where
 * audio exists.
 */
export function audioValidatedPct(p: PortfolioProject): number {
  return p.audioCells > 0 ? p.validatedAudioCells / p.audioCells : 0
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
