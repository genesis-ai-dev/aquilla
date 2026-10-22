/**
 * Pure portfolio math shared by the SPA and auth-worker.
 *
 * The worker imports this file directly. Keep it free of fetch, Vite env, and
 * `@/` imports so the identity worker can typecheck it.
 *
 * Overview totals are an unweighted mean of per-project fractions, plus counts
 * of stalled / overdue / attention projects. That is the All Orgs dashboard's
 * previous client-side rollup (OrgHome). A cell-weighted mean would change the
 * tiles, so this must not become one.
 */

import {
  laneCountsAudio,
  laneCountsText,
  laneMeasure,
  type LaneDelivers,
  type LaneMeasure,
} from "../lanes/lane-delivers"

const STALE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * A lane contributes its activity timestamp, and (media redesign slice 1) what
 * it delivers with the counts it is measured by. Everything but the timestamp
 * is optional: a server that predates a field sends none, and a caller that
 * only asks about activity passes none.
 */
type LaneActivity = {
  lastEditAt: number | null
  role?: "source" | "target"
  delivers?: LaneDelivers | null
  totalCells?: number
  filledCells?: number
  validatedCells?: number
  audioTotalCells?: number
  audioCells?: number
  validatedAudioCells?: number
  bothValidatedCells?: number
}

/** The target languages of a row; the source lane rides along for its label only. */
function targetLanes<L extends LaneActivity>(p: { lanes?: readonly L[] | null }): L[] {
  return (p.lanes ?? []).filter((lane) => lane.role !== "source")
}

/**
 * Media redesign slice 1: does any language of this project count its
 * recordings — Audio, or Text and audio? Only then are its numbers measured
 * language by language. A project whose every language is Text (or not chosen
 * yet) keeps the project-wide figures it always had, to the cell.
 */
export function portfolioCountsByLanguage<L extends LaneActivity>(p: { lanes?: readonly L[] | null }): boolean {
  return targetLanes(p).some((lane) => laneCountsAudio(lane.delivers))
}

/** Does any language of this project deliver text? A project with no languages yet does. */
export function portfolioDeliversText<L extends LaneActivity>(p: { lanes?: readonly L[] | null }): boolean {
  const targets = targetLanes(p)
  return targets.length === 0 || targets.some((lane) => laneCountsText(lane.delivers))
}

/** One language measured by what it delivers (src/lib/lanes/lane-delivers.ts). */
export function portfolioLaneMeasure(lane: LaneActivity): LaneMeasure {
  const total = lane.totalCells ?? 0
  return laneMeasure(lane.delivers, {
    total,
    filled: lane.filledCells ?? 0,
    validated: lane.validatedCells ?? 0,
    audioTotal: lane.audioTotalCells ?? total,
    recorded: lane.audioCells ?? 0,
    audioApproved: lane.validatedAudioCells ?? 0,
    bothApproved: lane.bothValidatedCells ?? 0,
  })
}

/**
 * The project measured by what each of its languages delivers: done lines
 * across all languages over all their lines (gap 5). A project of Text
 * languages reads its project-wide figures, exactly as before.
 */
export function portfolioMeasure<L extends LaneActivity>(
  p: { totalCells: number; filledCells: number; validatedCells: number; lanes?: readonly L[] | null },
): LaneMeasure {
  if (!portfolioCountsByLanguage(p)) {
    return { total: p.totalCells, started: p.filledCells, done: p.validatedCells, headline: p.filledCells }
  }
  const sum: LaneMeasure = { total: 0, started: 0, done: 0, headline: 0 }
  for (const lane of targetLanes(p)) {
    const m = portfolioLaneMeasure(lane)
    sum.total += m.total
    sum.started += m.started
    sum.done += m.done
    sum.headline += m.headline
  }
  return sum
}

/**
 * The project's TEXT figures, over the languages that deliver text. A Text
 * project reads its project-wide figures; one with an Audio language leaves
 * that language's (empty) text out, so a French text beside a Swahili audio
 * reads French's translated share rather than half of it.
 */
export function portfolioText<L extends LaneActivity>(
  p: { totalCells: number; filledCells: number; validatedCells: number; lanes?: readonly L[] | null },
): { total: number; filled: number } {
  if (!portfolioCountsByLanguage(p)) return { total: p.totalCells, filled: p.filledCells }
  let total = 0
  let filled = 0
  for (const lane of targetLanes(p)) {
    if (!laneCountsText(lane.delivers)) continue
    total += lane.totalCells ?? 0
    filled += lane.filledCells ?? 0
  }
  return { total, filled }
}

/** Lines with any work in them, by what each language delivers. Text: lines with text. */
function portfolioStarted<L extends LaneActivity>(p: { filledCells: number; lanes?: readonly L[] | null }): number {
  if (!portfolioCountsByLanguage(p)) return p.filledCells
  return targetLanes(p).reduce((sum, lane) => sum + portfolioLaneMeasure(lane).started, 0)
}

/** Fields the overview rollup reads. A full portfolio row satisfies this. */
export interface PortfolioMetricsProject {
  totalCells: number
  validatedCells: number
  filledCells: number
  lastEditAt: number | null
  /**
   * AQU-1566: what audio coverage is measured against — each file's cue sheet
   * where it has one, the file itself otherwise (the plan board's own rule).
   * Optional because an older server sends none; `audioDenominator` then
   * falls back to `totalCells`.
   */
  audioTotalCells?: number
  audioCells: number
  deadlineAt: string | null
  lanes?: readonly LaneActivity[]
  unitsOverdue?: number
}

/**
 * Done fraction 0..1 (0 when no cells): validated text for a Text project, as
 * always; with an Audio or a Text and audio language, the lines done by what
 * each language delivers (media redesign slice 1).
 */
export function validatedPct(
  p: Pick<PortfolioMetricsProject, "totalCells" | "validatedCells"> &
    Partial<Pick<PortfolioMetricsProject, "filledCells" | "lanes">>,
): number {
  const m = portfolioMeasure({ filledCells: 0, ...p })
  return m.total > 0 ? m.done / m.total : 0
}

/**
 * Media redesign slice 1: the project's headline progress 0..1, by what each
 * language delivers — the translated share for a Text project, exactly as
 * before; approved recordings for an Audio one. What "least translated" and
 * "most progress" sort by, so an audio project is not filed as untouched.
 */
export function progressPct(
  p: Pick<PortfolioMetricsProject, "totalCells" | "filledCells"> &
    Partial<Pick<PortfolioMetricsProject, "validatedCells" | "lanes">>,
): number {
  const m = portfolioMeasure({ validatedCells: 0, ...p })
  return m.total > 0 ? m.headline / m.total : 0
}

/**
 * Media redesign slice 1: the share of lines with any work in them, by what
 * each language delivers — the translated share for a Text project, as before;
 * recorded lines for an Audio one. The lighter half of a done bar.
 */
export function startedPct(
  p: Pick<PortfolioMetricsProject, "totalCells" | "filledCells"> &
    Partial<Pick<PortfolioMetricsProject, "validatedCells" | "lanes">>,
): number {
  const m = portfolioMeasure({ validatedCells: 0, ...p })
  return m.total > 0 ? Math.min(1, m.started / m.total) : 0
}

/**
 * Translated (has-content) fraction 0..1 (0 when no cells), over the
 * languages that deliver text. A project whose languages all deliver audio has
 * no text to translate and reads 0 — callers show nothing for it
 * (`portfolioDeliversText`).
 */
export function translatedPct(
  p: Pick<PortfolioMetricsProject, "totalCells" | "filledCells"> &
    Partial<Pick<PortfolioMetricsProject, "validatedCells" | "lanes">>,
): number {
  const text = portfolioText({ validatedCells: 0, ...p })
  return text.total > 0 ? text.filled / text.total : 0
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

/**
 * AQU-1566: the cells audio is measured against. `totalCells` stopped carrying
 * the hidden cue sheet, so dividing the cue sheet's takes by it read a
 * part-recorded dubbing episode as 100% recorded.
 */
export function audioDenominator(p: Pick<PortfolioMetricsProject, "totalCells" | "audioTotalCells">): number {
  return p.audioTotalCells ?? p.totalCells
}

/** fraction of cells that have audio, 0..1 (0 when no cells). */
export function audioPct(p: Pick<PortfolioMetricsProject, "totalCells" | "audioTotalCells" | "audioCells">): number {
  const total = audioDenominator(p)
  return total > 0 ? Math.min(1, p.audioCells / total) : 0
}

/**
 * AQU-950: the most recent sign of work on the project — the signal the
 * "Stalled" flag and the attention sort are allowed to read.
 *
 * The scalar `lastEditAt` is `MAX(files.last_edit_at)`, which the sync-worker
 * derives from `MAX(cells.last_edit_at)`. Only events that WRITE A CELL ROW
 * stamp that column, so a team doing review work is invisible to it:
 * `cell.validate` / `cell.unvalidate` update `cell_validators`,
 * `cells.validated` and `cells.ai_drafted` and never touch `last_edit_at`.
 * The same is true of audio takes, which live in `cell_audio`. A project in
 * active review or active recording therefore went quiet on this signal and
 * was labelled "Stalled" after 14 days while its team was working in it daily
 * — the mislabelling ETEN raised twice.
 *
 * Each lane's `lastEditAt` is `file_section_progress.updated_at`, restamped
 * whenever ANY counter-affecting event lands on the file (validations and
 * audio included), so the max across the lanes is the honest "something
 * happened here" timestamp. It is already on the wire — no new bookkeeping.
 * Lanes are optional (an older server sends none), so the scalar remains the
 * floor rather than being replaced by it.
 */
export function latestActivityAt<L extends LaneActivity>(
  p: { lastEditAt?: number | null; lanes?: readonly L[] | null },
): number | null {
  let latest = p.lastEditAt ?? null
  for (const lane of p.lanes ?? []) {
    const at = lane.lastEditAt
    if (at != null && (latest == null || at > latest)) latest = at
  }
  return latest
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
export function deadlineStatus(p: Pick<PortfolioMetricsProject, "deadlineAt">, now: number): DeadlineStatus | null {
  if (!p.deadlineAt) return null
  const t = Date.parse(p.deadlineAt) // "YYYY-MM-DD" → UTC midnight of that date
  if (Number.isNaN(t)) return null
  if (isDeadlineOverdue(t, now)) return "overdue"
  // "soon": within 7 days, measured from AoE end-of-deadline-day to now
  if (t + AOE_GRACE_MS - now <= DEADLINE_SOON_WINDOW_MS) return "soon"
  return "ok"
}

export type PortfolioActivityStatus = "not-started" | "stalled" | "active"

/**
 * A project with no translated cells hasn't stalled — it just hasn't started
 * yet. We key "not-started" on translation progress (`filledCells`), NOT on a
 * null `lastEditAt`: importing source text stamps `files.last_edit_at` (source
 * cells carry `last_edit_at` = import time), so an imported-but-untranslated
 * project has a non-null `lastEditAt` even though no translation work has
 * happened. Gating on `lastEditAt == null` mislabeled those projects "Stalled"
 * once the import aged past the stale window (AQU-639).
 *
 * AQU-950: "has work happened recently" is `latestActivityAt`, NOT the scalar
 * `lastEditAt`. The scalar only moves when an event writes a cell row, so a
 * project whose team is validating or recording — real, daily work — read as
 * idle and was flagged "Stalled". See `latestActivityAt` for why the per-lane
 * timestamp is the honest signal.
 */
export function portfolioActivityStatus<L extends LaneActivity>(
  p: { filledCells: number; lastEditAt: number | null; lanes?: readonly L[] | null },
  now: number,
): PortfolioActivityStatus {
  // Media redesign slice 1: "started" by what each language delivers, so an
  // Audio project is under way from its first recording rather than "not
  // started" for as long as nobody types. A Text project: its filled cells.
  if (portfolioStarted(p) === 0) return "not-started"
  const activityAt = latestActivityAt(p)
  if (activityAt == null || now - activityAt > STALE_MS) return "stalled"
  return "active"
}

/** User-facing project health labels — single source of truth. */
export const PROJECT_STATUS_LABEL = {
  overdue: "Overdue",
  behindPlan: "Behind plan",
  soon: "Due soon",
  stalled: "Stalled",
  onTrack: "On track",
  archived: "Archived",
} as const

export type ProjectAttentionKind = "overdue" | "behind-plan" | "soon" | "stalled"

export interface ProjectAttentionReason {
  kind: ProjectAttentionKind
  label: string
}

/** Why an org portfolio project needs attention (deadline + activity). */
export function portfolioAttentionReasons<L extends LaneActivity>(
  p: {
    filledCells: number
    lastEditAt: number | null
    deadlineAt: string | null
    unitsOverdue?: number
    lanes?: readonly L[] | null
  },
  now: number,
): ProjectAttentionReason[] {
  const reasons: ProjectAttentionReason[] = []
  const dl = deadlineStatus(p, now)
  if (dl === "overdue") reasons.push({ kind: "overdue", label: PROJECT_STATUS_LABEL.overdue })
  else if (dl === "soon") reasons.push({ kind: "soon", label: PROJECT_STATUS_LABEL.soon })
  if (portfolioActivityStatus(p, now) === "stalled") {
    reasons.push({ kind: "stalled", label: PROJECT_STATUS_LABEL.stalled })
  }
  // AQU-1097: a project can be comfortably inside its own deadline while units
  // inside it are already late. That is the thing a PM overseeing many
  // languages needs to see without opening each project.
  //
  // It gets its OWN kind and its own word. Reusing "Overdue" made one label
  // mean two different things — the rollup count, the attention filter, the
  // sort rank and the deadline tooltip all still mean the project's own
  // deadline — so a row could read Overdue while every other surface agreed
  // the project was fine, and nothing told the reader which was meant.
  if (dl !== "overdue" && (p.unitsOverdue ?? 0) > 0) {
    reasons.push({ kind: "behind-plan", label: PROJECT_STATUS_LABEL.behindPlan })
  }
  return reasons
}

/** Whether the org overview counts this project as needing attention. */
export function projectNeedsPortfolioAttention<L extends LaneActivity>(
  p: {
    filledCells: number
    lastEditAt: number | null
    deadlineAt: string | null
    unitsOverdue?: number
    lanes?: readonly L[] | null
  },
  now: number,
): boolean {
  return portfolioAttentionReasons(p, now).length > 0
}

export interface PortfolioAggregate {
  projectCount: number
  avgTranslatedPct: number
  avgValidatedPct: number
  avgAudioPct: number
  stalledCount: number
  overdueCount: number
  attentionCount: number
}

export interface OrgPortfolioAggregate extends PortfolioAggregate {
  orgId: number
}

export function emptyPortfolioAggregate(): PortfolioAggregate {
  return {
    projectCount: 0,
    avgTranslatedPct: 0,
    avgValidatedPct: 0,
    avgAudioPct: 0,
    stalledCount: 0,
    overdueCount: 0,
    attentionCount: 0,
  }
}

/** Unweighted mean across projects. An empty list is all zeros, not NaN. */
export function summarizePortfolioProjects(
  projects: readonly PortfolioMetricsProject[],
  now: number,
): PortfolioAggregate {
  if (projects.length === 0) return emptyPortfolioAggregate()
  let translated = 0
  let textProjects = 0
  let validated = 0
  let audio = 0
  let stalled = 0
  let overdue = 0
  let attention = 0
  for (const project of projects) {
    // Media redesign slice 1: a project with no text to translate stays out of
    // the translated mean rather than pulling it down with a 0.
    if (portfolioDeliversText(project)) {
      translated += translatedPct(project)
      textProjects += 1
    }
    validated += validatedPct(project)
    audio += audioPct(project)
    if (portfolioActivityStatus(project, now) === "stalled") stalled += 1
    if (deadlineStatus(project, now) === "overdue") overdue += 1
    if (projectNeedsPortfolioAttention(project, now)) attention += 1
  }
  const n = projects.length
  return {
    projectCount: n,
    avgTranslatedPct: textProjects > 0 ? translated / textProjects : 0,
    avgValidatedPct: validated / n,
    avgAudioPct: audio / n,
    stalledCount: stalled,
    overdueCount: overdue,
    attentionCount: attention,
  }
}

/**
 * Totals over the flat project list (not the mean of per-org means) plus one
 * row per org in `orgIds`, including orgs with no visible projects.
 */
export function summarizePortfoliosByOrg(
  projects: readonly (PortfolioMetricsProject & { orgId: number })[],
  orgIds: readonly number[],
  now: number,
): { totals: PortfolioAggregate; orgs: OrgPortfolioAggregate[] } {
  const byOrg = new Map<number, Array<PortfolioMetricsProject & { orgId: number }>>()
  for (const orgId of orgIds) byOrg.set(orgId, [])
  for (const project of projects) {
    const list = byOrg.get(project.orgId)
    if (list) list.push(project)
    else byOrg.set(project.orgId, [project])
  }
  return {
    totals: summarizePortfolioProjects(projects, now),
    orgs: [...byOrg.entries()].map(([orgId, rows]) => ({
      orgId,
      ...summarizePortfolioProjects(rows, now),
    })),
  }
}
