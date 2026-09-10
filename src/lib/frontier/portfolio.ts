import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"
import { UserError } from "@/lib/errors/user-error"

/**
 * AQU-538: per-target-language-lane rollup for a project. `lane: ''` is the
 * default lane (the project's configured `targetLanguage`, labeled client-side)
 * and is present whenever the project has any file-scope progress rows.
 * `validatedCells` counts cells meeting the project's validation threshold in
 * that lane; `lastEditAt` is the lane's most recent progress update (null when
 * the lane has no activity yet).
 */
export interface PortfolioLane {
  lane: string
  totalCells: number
  filledCells: number
  validatedCells: number
  lastEditAt: number | null
}

export interface PortfolioProject {
  id: string
  name: string
  /**
   * AQU-538: per-lane rollups (default '' lane first). Optional so a client
   * talking to an older server (no lane dimension) degrades gracefully — treat
   * absent/empty as "single default lane" using the scalar fields.
   */
  lanes?: PortfolioLane[]
  totalCells: number
  validatedCells: number
  /** Target cells with content: the "translated" count (distinct from validated). */
  filledCells: number
  /**
   * AQU-292: target cells that were machine-drafted (AI completion path) and have
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
  sourceLanguage?: string | null
  targetLanguage?: string | null
  /**
   * AQU-507: the project's designated Project Manager, for the overview
   * sort/filter-by-PM lens. The portfolio endpoint does not carry it; the org
   * dashboard merges it in from the accessible-projects feed (the list
   * endpoint). Absent/null ⇒ unassigned (sorts last under the PM lens).
   */
  pm?: { id: number; username: string } | null
  /**
   * AQU-1097: planning units — the rows a manager plans by (a book inside a
   * whole-Bible import, a file otherwise). Optional because a server that
   * predates the plan board sends none, and the org table then shows no plan
   * column rather than a misleading "0 of 0".
   */
  unitsTotal?: number
  unitsDone?: number
  /** Past their target date with no Done mark. Counted server-side. */
  unitsOverdue?: number
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

export const PORTFOLIO_PAGE_SIZE = 40
/** Must match auth-worker PORTFOLIO_ORG_IDS_MAX. Over this, omit orgIds. */
export const PORTFOLIO_ORG_IDS_MAX = 500

export interface PortfolioDirectoryPage {
  projects: PortfolioProject[]
  nextCursor: string | null
}

export async function getPortfolioPage(
  jwt: string,
  orgId: number,
  opts: {
    q?: string
    limit?: number
    cursor?: string | null
    signal?: AbortSignal
  } = {},
): Promise<PortfolioDirectoryPage> {
  const params = new URLSearchParams()
  const q = opts.q?.trim()
  if (q) params.set("q", q)
  params.set("limit", String(opts.limit ?? PORTFOLIO_PAGE_SIZE))
  if (opts.cursor) params.set("cursor", opts.cursor)
  const res = await fetchWithTimeout(
    `${FRONTIER_BASE}/api/v2/orgs/${orgId}/portfolio?${params}`,
    { headers: { Authorization: `Bearer ${jwt}` }, signal: opts.signal },
  )
  if (!res.ok) throw new UserError(res.status, "", "org")
  const body = (await res.json()) as { projects: PortfolioProject[]; nextCursor?: string | null }
  return { projects: body.projects ?? [], nextCursor: body.nextCursor ?? null }
}

export type PortfolioBatchScope = "orgIds" | "memberships"

/** POST /orgs/portfolio body. All-orgs omits orgIds so the worker uses memberships
 *  (AQU-756) instead of sending a list that 400s past the worker's batch cap. */
export function portfolioBatchPayload(
  orgIds: number[],
  extra: Record<string, unknown> = {},
  scope: PortfolioBatchScope = "orgIds",
): ({ orgIds?: number[] } & Record<string, unknown>) | null {
  const uniqueOrgIds = [...new Set(orgIds)].filter((id) => Number.isInteger(id) && id > 0)
  const omitOrgIds = scope === "memberships" || uniqueOrgIds.length > PORTFOLIO_ORG_IDS_MAX
  if (!omitOrgIds && uniqueOrgIds.length === 0) return null
  return {
    ...(omitOrgIds ? {} : { orgIds: uniqueOrgIds }),
    ...extra,
  }
}

export async function getPortfoliosPage(
  jwt: string,
  orgIds: number[],
  opts: {
    q?: string
    limit?: number
    cursor?: string | null
    signal?: AbortSignal
    scope?: PortfolioBatchScope
  } = {},
): Promise<{ projects: Array<PortfolioProject & { orgId: number }>; nextCursor: string | null }> {
  const body = portfolioBatchPayload(
    orgIds,
    {
      q: opts.q?.trim() || undefined,
      limit: opts.limit ?? PORTFOLIO_PAGE_SIZE,
      cursor: opts.cursor || undefined,
    },
    opts.scope ?? "orgIds",
  )
  if (!body) return { projects: [], nextCursor: null }
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/portfolio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    signal: opts.signal,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new UserError(res.status, "", "org")
  const payload = (await res.json()) as {
    portfolios: OrgPortfolio[]
    nextCursor?: string | null
  }
  return {
    projects: (payload.portfolios ?? []).flatMap((portfolio) =>
      portfolio.projects.map((project) => ({ ...project, orgId: portfolio.orgId })),
    ),
    nextCursor: payload.nextCursor ?? null,
  }
}

export async function getPortfolios(
  jwt: string,
  orgIds: number[],
  opts: { scope?: PortfolioBatchScope } = {},
): Promise<OrgPortfolio[]> {
  const body = portfolioBatchPayload(orgIds, {}, opts.scope ?? "orgIds")
  if (!body) return []
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/portfolio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
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

/** translated (has-content) fraction 0..1 for a single lane (0 when no cells). */
export function laneTranslatedPct(lane: PortfolioLane): number {
  return lane.totalCells > 0 ? lane.filledCells / lane.totalCells : 0
}

/** validated fraction 0..1 for a single lane (0 when no cells). */
export function laneValidatedPct(lane: PortfolioLane): number {
  return lane.totalCells > 0 ? lane.validatedCells / lane.totalCells : 0
}

/**
 * AQU-292: fraction of cells that are AI-drafted and awaiting human review, 0..1.
 * 0 for projects that predate the provenance marker (forward-only, honest).
 */
export function aiDraftedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.aiDraftedCells / p.totalCells : 0
}

/**
 * WHY BOTH AUDIO FRACTIONS CLAMP AND THE TEXT ONES DO NOT.
 *
 * The text counts and their denominator come from the same rows, so
 * `filledCells <= totalCells` is structurally true. The audio counts do not:
 * `auth-worker/src/services/org-permissions.ts` builds them in a `cell_audio`
 * CTE keyed on `project_id` ALONE, while `totalCells` is `SUM(files.cell_count)`
 * — the two are never joined. Audio left behind on a tombstoned or re-imported
 * file therefore counts in the numerator and not the denominator, and `StatTile`
 * renders `Math.round(pct * 100)` with no ceiling of its own. Without the clamp
 * that is a tile reading "140%".
 */

/** fraction of cells that have audio, 0..1 (0 when no cells). */
export function audioPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? Math.min(1, p.audioCells / p.totalCells) : 0
}

/**
 * AQU-508/AQU-1093: fraction of ALL cells whose selected take is validated,
 * 0..1 (0 when the project has no cells).
 *
 * Denominator is `totalCells`, matching every sibling here and — the reason it
 * changed — matching the plan board, whose per-unit bars and CSV divide audio
 * validated by every cell in the unit. AQU-1093 requires the Progress card's
 * audio tiles to stay consistent with what the rows sum to, and until this
 * changed the two surfaces reported different percentages for one project on
 * one page. The share of RECORDED audio that is validated is still worth
 * knowing, so the tile's tooltip carries it as a second sentence.
 */
export function audioValidatedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? Math.min(1, p.validatedAudioCells / p.totalCells) : 0
}

/**
 * The old `audioValidatedPct`: validated audio as a share of the audio that
 * actually exists, 0..1 (0 when nothing is recorded). A reviewer's question —
 * "of what we have recorded, how much have we checked" — rather than a
 * progress-toward-done one, which is why it lives in a tooltip and not a tile.
 */
export function audioValidatedOfRecordedPct(p: PortfolioProject): number {
  return p.audioCells > 0 ? Math.min(1, p.validatedAudioCells / p.audioCells) : 0
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
/** 1 day + 12 hours: the grace that makes a date AoE (see the block above). */
export const AOE_GRACE_MS = (24 + 12) * 60 * 60 * 1000

/** How far ahead of its AoE end a date counts as "due soon". */
export const DEADLINE_SOON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function isDeadlineOverdue(deadlineUtcMidnight: number, nowMs: number): boolean {
  return nowMs >= deadlineUtcMidnight + AOE_GRACE_MS
}

/** null when no deadline; "overdue" past due; "soon" within 7 days; else "ok". */
export function deadlineStatus(p: PortfolioProject, now: number): DeadlineStatus | null {
  if (!p.deadlineAt) return null
  const t = Date.parse(p.deadlineAt) // "YYYY-MM-DD" → UTC midnight of that date
  if (Number.isNaN(t)) return null
  if (isDeadlineOverdue(t, now)) return "overdue"
  // "soon": within 7 days, measured from AoE end-of-deadline-day to now
  if (t + AOE_GRACE_MS - now <= DEADLINE_SOON_WINDOW_MS) return "soon"
  return "ok"
}

/** Attention score: higher = more attention needed. Overdue ranks above stalled, which ranks above low completion. */
export function attentionRank(p: PortfolioProject, now: number): number {
  const ageMs = p.lastEditAt != null ? now - p.lastEditAt : Infinity
  const stale = ageMs > 14 * 24 * 60 * 60 * 1000 ? 1 : 0
  const overdue = deadlineStatus(p, now) === "overdue" ? 1 : 0
  // AQU-1097: a project whose own deadline holds but whose units are already
  // late sorts between "overdue" and "stalled" — more urgent than idle work,
  // less urgent than a blown deadline. Without this the status column could
  // show a reason the sort did not rank, so ordering by Status left the
  // flagged rows scattered.
  const behindPlan = !overdue && (p.unitsOverdue ?? 0) > 0 ? 1 : 0
  return overdue * 2000 + behindPlan * 1500 + stale * 1000 + (1 - validatedPct(p)) * 100
}
