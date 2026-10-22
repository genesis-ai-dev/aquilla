import { FRONTIER_BASE } from "./auth"
import { fetchWithTimeout } from "./orgs"
import { UserError } from "@/lib/errors/user-error"
import { deliversView, type LaneDelivers } from "@/lib/lanes/lane-delivers"
import {
  audioDenominator,
  deadlineStatus,
  emptyPortfolioAggregate,
  latestActivityAt,
  portfolioLaneMeasure,
  validatedPct,
  type OrgPortfolioAggregate,
  type PortfolioAggregate,
} from "./portfolio-metrics"

export {
  AOE_GRACE_MS,
  DEADLINE_SOON_WINDOW_MS,
  audioDenominator,
  audioPct,
  deadlineStatus,
  isDeadlineOverdue,
  latestActivityAt,
  portfolioActivityStatus,
  portfolioCountsByLanguage,
  portfolioDeliversText,
  portfolioLaneMeasure,
  portfolioMeasure,
  portfolioText,
  portfolioTextMeasure,
  progressPct,
  startedPct,
  textValidatedPct,
  translatedPct,
  validatedPct,
  type DeadlineStatus,
} from "./portfolio-metrics"

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
  /** Display name from the lane row. Absent on older servers. */
  name?: string | null
  /** Opaque lane id. Deep links may use this instead of the tag. */
  laneId?: string | null
  /** Display order from `lanes.position`. */
  position?: number
  /** AQU-1458. Absent on older servers, which means "not archived". */
  archived?: boolean
  /** Source rows are for the language pair. Chips list target lanes only. */
  role?: "source" | "target"
  /**
   * AQU-1951: this language's recordings — cells with a selected dub take in
   * this lane, and those whose takes meet the audio threshold. Absent on older
   * servers.
   */
  audioCells?: number
  validatedAudioCells?: number
  /**
   * AQU-1954: what this language's recordings are measured against: every
   * file when its "Records audio" switch is on, else the files it has recorded
   * in (and any file with a cue sheet). 0 means the language owes no audio.
   * Absent on older servers, which measured against the project's total.
   */
  audioTotalCells?: number
  /** AQU-1954: the language row's "Records audio" switch. */
  recordsAudio?: boolean
  /**
   * Media redesign slice 1: what this language delivers — Text, Audio, or Text
   * and audio — or null when nobody has chosen yet (counts as Text). Absent on
   * older servers, which also reads as Text.
   */
  delivers?: LaneDelivers | null
  /**
   * Media redesign slice 1: lines with BOTH their text validated and their
   * recording approved — what a "Text and audio" language counts as done.
   * Absent on older servers.
   */
  bothValidatedCells?: number
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
  /**
   * AQU-1566: what audio coverage is measured against. A dubbing project
   * records against its hidden cue sheet, not its subtitles, and the two have
   * different counts, so this is each file's cue sheet where it has one and
   * the file itself otherwise: the plan board's own rule. Optional because an
   * older server sends none; `audioDenominator` then falls back to the text
   * total, as it always did.
   */
  audioTotalCells?: number
  /**
   * AQU-1954: whether any of the project's languages has its "Records audio"
   * switch on, so the Progress card shows audio before the first take.
   * Optional because an older server sends none, which reads as off.
   */
  recordsAudio?: boolean
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
const LANE_PLACEHOLDER_LABELS = new Set(["Source", "Untitled lane"])

function laneLabelText(lane: PortfolioLane | undefined): string | null {
  const name = lane?.name?.trim()
  if (!name || LANE_PLACEHOLDER_LABELS.has(name)) return null
  return name
}

/** Source language from the source lane row, else a payload that still sends the field. */
export function portfolioSourceLabel(p: {
  lanes?: PortfolioLane[]
  sourceLanguage?: string | null
}): string | null {
  const fromLane = laneLabelText(p.lanes?.find((lane) => lane.role === "source"))
  return fromLane || p.sourceLanguage?.trim() || null
}

/** The former default lane's label, else a payload that still sends targetLanguage. */
export function portfolioTargetLabel(p: {
  lanes?: PortfolioLane[]
  targetLanguage?: string | null
}): string | null {
  const fromLane = laneLabelText(
    p.lanes?.find((lane) => lane.role !== "source" && lane.lane === ""),
  )
  return fromLane || p.targetLanguage?.trim() || null
}

/**
 * AQU-1977: the project's MAIN target language — its former default ('')
 * lane while it has one, which keeps an old project's label, otherwise its
 * first live target lane in position order, the lane the editor opens. A
 * project made since AQU-1594 has no '' lane, so the '' lookup alone named
 * nothing and its pair read "English" with no target.
 */
export function portfolioMainTargetLabel(p: {
  lanes?: PortfolioLane[]
  targetLanguage?: string | null
}): string | null {
  const fromDefault = portfolioTargetLabel(p)
  if (fromDefault) return fromDefault
  const first = (p.lanes ?? [])
    .filter((lane) => lane.role !== "source" && lane.archived !== true)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]
  return laneLabelText(first) ?? null
}

export function languagePairLabel(p: {
  lanes?: PortfolioLane[]
  sourceLanguage?: string | null
  targetLanguage?: string | null
}): string | null {
  const source = portfolioSourceLabel(p)
  const target = portfolioMainTargetLabel(p)
  if (source && target) return `${source} → ${target}`
  return target ?? source ?? null
}

export interface OrgPortfolio {
  orgId: number
  projects: PortfolioProject[]
}

/**
 * AQU-1071: an org's rollup plus the enterprise billing band — active target
 * lanes, counted server-side by the same helper billing uses.
 */
export interface OrgPortfolioSummary {
  projects: PortfolioProject[]
  /** 0 from a server that predates the field, so a tile reads 0 rather than NaN. */
  activeLanguageCount: number
}

export async function getOrgPortfolioSummary(
  jwt: string,
  orgId: number,
): Promise<OrgPortfolioSummary> {
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/portfolio`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new UserError(res.status, "", "org")
  const body = (await res.json()) as {
    projects?: PortfolioProject[]
    activeLanguageCount?: number
  }
  return {
    projects: body.projects ?? [],
    activeLanguageCount: Number.isFinite(body.activeLanguageCount)
      ? Number(body.activeLanguageCount)
      : 0,
  }
}

export async function getPortfolio(jwt: string, orgId: number): Promise<PortfolioProject[]> {
  return (await getOrgPortfolioSummary(jwt, orgId)).projects
}

export const PORTFOLIO_PAGE_SIZE = 40

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

export async function getPortfoliosPage(
  jwt: string,
  orgIds: number[],
  opts: {
    q?: string
    limit?: number
    cursor?: string | null
    signal?: AbortSignal
  } = {},
): Promise<{ projects: Array<PortfolioProject & { orgId: number }>; nextCursor: string | null }> {
  const uniqueOrgIds = [...new Set(orgIds)].filter((id) => Number.isInteger(id) && id > 0)
  if (uniqueOrgIds.length === 0) return { projects: [], nextCursor: null }
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/portfolio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    signal: opts.signal,
    body: JSON.stringify({
      orgIds: uniqueOrgIds,
      q: opts.q?.trim() || undefined,
      limit: opts.limit ?? PORTFOLIO_PAGE_SIZE,
      cursor: opts.cursor || undefined,
    }),
  })
  if (!res.ok) throw new UserError(res.status, "", "org")
  const body = (await res.json()) as {
    portfolios: OrgPortfolio[]
    nextCursor?: string | null
  }
  return {
    projects: (body.portfolios ?? []).flatMap((portfolio) =>
      portfolio.projects.map((project) => ({ ...project, orgId: portfolio.orgId })),
    ),
    nextCursor: body.nextCursor ?? null,
  }
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

export interface PortfolioAggregates extends PortfolioAggregate {
  orgs: OrgPortfolioAggregate[]
}

function readAggregate(body: Partial<PortfolioAggregate> | null | undefined): PortfolioAggregate {
  const empty = emptyPortfolioAggregate()
  if (!body) return empty
  const num = (value: unknown, fallback: number) => {
    const n = typeof value === "number" ? value : Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    projectCount: num(body.projectCount, empty.projectCount),
    avgTranslatedPct: num(body.avgTranslatedPct, empty.avgTranslatedPct),
    avgValidatedPct: num(body.avgValidatedPct, empty.avgValidatedPct),
    avgAudioPct: num(body.avgAudioPct, empty.avgAudioPct),
    stalledCount: num(body.stalledCount, empty.stalledCount),
    overdueCount: num(body.overdueCount, empty.overdueCount),
    attentionCount: num(body.attentionCount, empty.attentionCount),
  }
}

/** All-orgs overview totals for these orgs. There is no org-count cap. */
export async function getPortfolioAggregates(
  jwt: string,
  orgIds: number[],
): Promise<PortfolioAggregates> {
  const uniqueOrgIds = [...new Set(orgIds)].filter((id) => Number.isInteger(id) && id > 0)
  if (uniqueOrgIds.length === 0) return { ...emptyPortfolioAggregate(), orgs: [] }
  const res = await fetchWithTimeout(`${FRONTIER_BASE}/api/v2/orgs/portfolio/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ orgIds: uniqueOrgIds }),
  })
  if (!res.ok) throw new UserError(res.status, "", "org")
  const body = (await res.json()) as Partial<PortfolioAggregate> & {
    orgs?: Array<Partial<OrgPortfolioAggregate> & { orgId?: number }>
  }
  return {
    ...readAggregate(body),
    orgs: (body.orgs ?? []).flatMap((row) => {
      const orgId = Number(row.orgId)
      if (!Number.isInteger(orgId) || orgId <= 0) return []
      return [{ orgId, ...readAggregate(row) }]
    }),
  }
}

/**
 * AQU-2116: is the language being viewed AUDIO-ONLY — recorded, and carrying no
 * target text anywhere in it?
 *
 * The Progress card drops its text tiles, bars and Customize entries when this
 * is true, so an audio-only project stops reading "Translated 0% · Validated
 * 0%" beside its real audio figures. A PM reading those zeroes concluded the
 * verifications had never registered.
 *
 * Decided on EVIDENCE, exactly the way the plan board already decides it
 * (`planUnitExpectsText`, AQU-955): recording has to have started before the
 * absence of text means anything. A language whose "Records audio" switch is on
 * but has recorded nothing, and a brand-new project with neither text nor
 * takes, both still owe text — asking the switch here (AQU-1954) would call
 * every untouched language that records audio audio-only.
 *
 * `lane` is the language tab being viewed, null for "All". On "All" the text
 * figures go only when NO target language has any text. A lane from a server
 * too old to send per-lane audio (AQU-1951) cannot answer the question, so it
 * answers "no" and the text figures stay exactly as they were.
 */
export function isAudioOnlyView(p: PortfolioProject, lane: PortfolioLane | null): boolean {
  if (lane != null) {
    if (lane.audioCells == null) return false
    return lane.filledCells === 0 && lane.audioCells > 0
  }
  const textAnywhere =
    p.filledCells > 0 || (p.lanes ?? []).some((l) => l.role !== "source" && l.filledCells > 0)
  return !textAnywhere && p.audioCells > 0
}

/**
 * Media redesign: does the Progress card show TEXT figures for the language
 * (or, on "All", the languages) in view? Each language answers by what it
 * delivers (`deliversView`), and one nobody has chosen for answers by evidence
 * exactly as `isAudioOnlyView` does. A view where nobody has chosen anything
 * keeps AQU-2116's answer to the letter.
 */
export function portfolioShowsText(p: PortfolioProject, lane: PortfolioLane | null): boolean {
  const lanes = lane != null ? [lane] : (p.lanes ?? []).filter((l) => l.role !== "source")
  if (!lanes.some((l) => l.delivers != null)) return !isAudioOnlyView(p, lane)
  return lanes.some((l) => deliversView(l.delivers, isAudioOnlyView(p, l) ? "audio" : "text") !== "audio")
}

/** translated (has-content) fraction 0..1 for a single lane (0 when no cells). */
export function laneTranslatedPct(lane: PortfolioLane): number {
  return lane.totalCells > 0 ? lane.filledCells / lane.totalCells : 0
}

/**
 * Media redesign slice 1: the share of a lane's lines with any of its
 * deliverable in them, 0..1 — its translated share for a Text language, as
 * before; its recorded share for an Audio one. The lighter half of its bar.
 */
export function laneStartedPct(lane: PortfolioLane): number {
  const m = portfolioLaneMeasure(lane)
  return m.total > 0 ? Math.min(1, m.started / m.total) : 0
}

/** Media redesign slice 1: a language that delivers audio and no text. */
export function laneDeliversAudioOnly(lane: Pick<PortfolioLane, "delivers">): boolean {
  return lane.delivers === "audio"
}

/**
 * Done fraction 0..1 for a single lane (0 when no cells): validated text for a
 * Text language, approved recordings for an Audio one, both for Text and audio
 * (media redesign slice 1).
 */
export function laneValidatedPct(lane: PortfolioLane): number {
  const m = portfolioLaneMeasure(lane)
  return m.total > 0 ? m.done / m.total : 0
}

/**
 * AQU-292: fraction of cells that are AI-drafted and awaiting human review, 0..1.
 * 0 for projects that predate the provenance marker (forward-only, honest).
 */
export function aiDraftedPct(p: PortfolioProject): number {
  return p.totalCells > 0 ? p.aiDraftedCells / p.totalCells : 0
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
  const total = audioDenominator(p)
  return total > 0 ? Math.min(1, p.validatedAudioCells / total) : 0
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

/** Attention score: higher = more attention needed. Overdue ranks above stalled, which ranks above low completion. */
export function attentionRank(p: PortfolioProject, now: number): number {
  // AQU-950: same activity signal the Stalled chip reads, so the sort can
  // never rank a row as idle while the status column says it is not.
  const activityAt = latestActivityAt(p)
  const ageMs = activityAt != null ? now - activityAt : Infinity
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
