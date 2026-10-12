// Project metrics for the Monday push engine + AI analyze context.
//
// Sources (shared Postgres — the sync worker maintains these projections):
//   * file_section_progress (scope='file') — totals/filled + validator
//     histogram per (file, TARGET lane; the source lane's row is the
//     lane-independent denominator and is left out). Aggregated across all
//     target lanes (v1), falling
//     back to files.cell_count/filled_count/approved_count when a file has no
//     progress rows yet (pre-backfill). That fallback only stands on a project
//     with at most one target lane — see `singleLane` below (AQU-1620).
//   * project_settings.validation_count (generated column) and the
//     validationCountAudio key for validation thresholds. Same thresholding as
//     sync-worker's progress-read-route: a cell counts as validated when its
//     endorsement bucket >= threshold.
//   * project_members (role >= CONTRIBUTOR 400) joined to users — v1
//     approximation of "translators".
//   * events.server_ts max — last activity (UTC date-only); now() if the
//     events table is unreachable.
//   * file_section_progress.audio_count — cells with a selected dub take, the
//     dashboard's "Has audio" (db/shared/audio-progress.ts `has_dub`).
//   * projects.deadline_at — the project's deadline, a calendar date; every
//     file row carries the project's.

import { ROLE } from "../../types"
import { countedFileSql, inAudioCountedFileSql } from "../../../../db/shared/counted-files"
import { aoeTodayIso, planUnitCountsSql, planUnitsSql } from "../../../../db/shared/plan-units"
import {
  PROJECT_STATUS_LABEL,
  portfolioAttentionReasons,
} from "../../../../src/lib/frontier/portfolio-metrics"
import { laneDisplayName } from "../../../../src/lib/lanes/lane-display"

export interface MondayEntityMetrics {
  completion_pct: number
  validated_pct: number
  audio_validated_pct: number
  has_audio_pct: number
  filled_count: number
  total_count: number
  validated_count: number
  translators: string
  last_activity: string // 'YYYY-MM-DD' UTC
  status_auto: "Not started" | "In progress" | "Complete"
  /** 'YYYY-MM-DD', or null when the project has no deadline (the cell is cleared). */
  deadline: string | null
  /** Opens the project (a file row: that file in the editor) in Aquilla. */
  project_link: string
  /** The org dashboard's deadline and plan flags, as one label. */
  schedule_status: "On track" | "Due soon" | "Overdue" | "Behind plan"
  /** "12 of 27": plan units marked Done, of all units (a file row: its own). */
  books_done: string
  /** Nearest target date of a unit not yet done and not yet late, or null. */
  next_target_date: string | null
  /** Whole days since the last activity; null when there has been none. */
  days_since_activity: number | null
  /** The project manager's display name, or "" when none is set. */
  project_manager: string
  /** The project's active target languages, comma-joined. */
  languages: string
  /** Distinct people who wrote anything in the project in the last 30 days. */
  active_contributors_30d: number
  /** Units under way (started, not marked Done), comma-joined (a file row: its own). */
  books_in_progress: string
  /** Minutes of selected dub audio, 1 dp (the dashboard's "recorded"). */
  recorded_minutes: number
}

/** Project-wide facts every row shares (a file row overrides some of them). */
interface ProjectFacts {
  deadline: string | null
  project_link: string
  schedule_status: MondayEntityMetrics["schedule_status"]
  books_done: string
  next_target_date: string | null
  days_since_activity: number | null
  project_manager: string
  languages: string
  active_contributors_30d: number
  books_in_progress: string
  recorded_minutes: number
}

interface UnitRow {
  file_id: string
  file_name: string
  section_key: string
  target_date: string | null
  done_at: number | string | null
  started: boolean
}

/** What the plan board says about a set of units (the whole project, or one file). */
function planFacts(units: UnitRow[], today: string) {
  const done = units.filter((u) => u.done_at != null).length
  const upcoming = units
    .filter((u) => u.done_at == null && u.target_date && u.target_date >= today)
    .map((u) => u.target_date as string)
    .sort()
  const inProgress = units
    .filter((u) => u.done_at == null && u.started)
    .map((u) => (u.section_key ? u.section_key : u.file_name))
  return {
    books_done: units.length > 0 ? `${done} of ${units.length}` : "",
    next_target_date: upcoming[0] ?? null,
    books_in_progress: inProgress.join(", "),
  }
}

/**
 * One label from the org dashboard's own attention rules
 * (`portfolioAttentionReasons`): the project's deadline under the
 * Anywhere-on-Earth rule, and "Behind plan" when a unit is past its target.
 * Stalled is left out (it is about activity, which has its own columns).
 * Most serious first: Overdue, Behind plan, Due soon, else On track.
 */
function scheduleStatus(deadline: string | null, unitsOverdue: number, now: number): ProjectFacts["schedule_status"] {
  const kinds = new Set(
    portfolioAttentionReasons({ filledCells: 1, lastEditAt: now, deadlineAt: deadline, unitsOverdue }, now).map(
      (r) => r.kind,
    ),
  )
  if (kinds.has("overdue")) return PROJECT_STATUS_LABEL.overdue
  if (kinds.has("behind-plan")) return PROJECT_STATUS_LABEL.behindPlan
  if (kinds.has("soon")) return PROJECT_STATUS_LABEL.soon
  return PROJECT_STATUS_LABEL.onTrack
}

export interface FileMetricsEntry {
  fileId: string
  fileName: string
  metrics: MondayEntityMetrics
}

export interface ProjectMetricsSummary {
  projectId: string
  projectName: string
  project: MondayEntityMetrics
  files: FileMetricsEntry[]
}

interface FileRow {
  id: string
  name: string
  cell_count: number
  filled_count: number
  approved_count: number
  structural_cell_count: number
  structural_filled_count: number
  structural_approved_count: number
}

interface ProgressRow {
  file_id: string
  total_count: number
  filled_count: number
  validator_histogram: unknown
  structural_count: number
  structural_filled_count: number
  structural_validator_histogram: unknown
  audio_validator_histogram: unknown
  structural_audio_validator_histogram: unknown
  audio_count: number
  structural_audio_count: number
}

function parseHistogram(raw: unknown): Map<number, number> {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      value = null
    }
  }
  const out = new Map<number, number>()
  if (!value || typeof value !== "object" || Array.isArray(value)) return out
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const bucket = Number(key)
    const amount = Number(count)
    if (Number.isInteger(bucket) && bucket >= 0 && Number.isFinite(amount) && amount > 0) {
      out.set(bucket, (out.get(bucket) ?? 0) + amount)
    }
  }
  return out
}

function validatedAtThreshold(histogram: Map<number, number>, threshold: number): number {
  let count = 0
  for (const [bucket, amount] of histogram) if (bucket >= threshold) count += amount
  return count
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

interface EntityTotals {
  total: number
  filled: number
  validated: number
  audioValidated: number
  hasAudio: number
}

function buildMetrics(
  totals: EntityTotals,
  translators: string,
  lastActivity: string,
  facts: ProjectFacts,
): MondayEntityMetrics {
  const { total, filled, validated, audioValidated, hasAudio } = totals
  const completionPct = total > 0 ? round1((filled / total) * 100) : 0
  return {
    completion_pct: completionPct,
    validated_pct: total > 0 ? round1((validated / total) * 100) : 0,
    audio_validated_pct: total > 0 ? round1((audioValidated / total) * 100) : 0,
    has_audio_pct: total > 0 ? round1((Math.min(hasAudio, total) / total) * 100) : 0,
    filled_count: filled,
    total_count: total,
    validated_count: validated,
    translators,
    last_activity: lastActivity,
    status_auto: filled <= 0 ? "Not started" : completionPct >= 100 ? "Complete" : "In progress",
    ...facts,
  }
}

/** projects.deadline_at is a calendar date string; anything unusable reads as no deadline. */
function toDeadline(raw: unknown): string | null {
  if (raw == null) return null
  const text = raw instanceof Date ? raw.toISOString() : String(raw)
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text.trim())
  return match ? match[1]! : null
}

/** Same clamp as every other reader of these counts (progress read, portfolio): 1–15. */
const MAX_VALIDATION_LEVELS = 15

function toThreshold(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_VALIDATION_LEVELS, Math.floor(n)) : 1
}

/** Bucket-wise subtraction, because validatedAtThreshold reads cumulatively. */
function subtractHistogram(from: Map<number, number>, raw: unknown): void {
  for (const [bucket, amount] of parseHistogram(raw)) {
    const remaining = (from.get(bucket) ?? 0) - amount
    if (remaining > 0) from.set(bucket, remaining)
    else from.delete(bucket)
  }
}

/** Compute project + per-file metrics. Returns null if the project doesn't exist. */
export async function computeProjectMetrics(
  db: AquillaDb,
  projectId: string,
  opts: { appBaseUrl?: string | null; now?: number } = {},
): Promise<ProjectMetricsSummary | null> {
  const now = opts.now ?? Date.now()
  const appBase = (opts.appBaseUrl || "https://aquilla.app").replace(/\/+$/, "")
  const project = await db
    .prepare(
      `SELECT p.id, p.name, p.deadline_at, COALESCE(NULLIF(pm.display_name, ''), pm.username) AS pm_name
         FROM projects p LEFT JOIN users pm ON pm.id = p.pm_user_id
        WHERE p.id = ?`,
    )
    .bind(projectId)
    .first<{ id: string; name: string; deadline_at: unknown; pm_name: string | null }>()
  if (!project) return null
  const deadline = toDeadline(project.deadline_at)

  // Validation thresholds. validation_count is a generated column (never read
  // the multi-MB settings blob inline for it); validationCountAudio has no
  // generated column yet — a single-project jsonb extract is acceptable here
  // (the org-portfolio timeout was a fan-out over every project).
  const settings = await db
    .prepare(
      `SELECT validation_count,
              (settings::jsonb)->>'validationCountAudio' AS validation_count_audio
         FROM project_settings WHERE project_id = ?`,
    )
    .bind(projectId)
    .first<{ validation_count: string | null; validation_count_audio: string | null }>()
  const threshold = toThreshold(settings?.validation_count)
  // AQU-1771: an unset audio count means one vote, as on the dashboards. It
  // used to fall back to the TEXT count, so a project needing two text votes
  // reported its audio against two as well.
  const audioThreshold = toThreshold(settings?.validation_count_audio)

  // AQU-1083: do headings count? The project's answer, else its org's, else
  // yes. Generated columns on both, for the reason stated above about blobs.
  const policy = await db
    .prepare(
      `SELECT COALESCE(ps.count_structural, os.count_structural) AS effective
         FROM projects p
         LEFT JOIN project_settings ps ON ps.project_id = p.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.id = ?`,
    )
    .bind(projectId)
    .first<{ effective: string | null }>()
  // Monday must agree with the dashboard: these numbers are pushed to a board
  // people plan against, and a board that disagrees with the app is worse than
  // one that is merely out of date.
  const countStructural = policy?.effective !== 'false'

  // AQU-1620: `files.filled_count` / `approved_count` sum every target lane,
  // while `files.cell_count` counts each cell once — so the pre-backfill
  // fallback below was dividing an all-lanes fill by a one-lane total and
  // completion could pass 100%. Same rule as the progress read fallback
  // (AQU-1588): with at most one target lane the file counters *are* that
  // lane's work, so they stand; with two or more the sum is partly another
  // lane's work, so the numerators are empty rather than wrong. None yet
  // counts as one and an archived lane still counts, because both are what
  // the counters already added up. The denominator is `files.cell_count`
  // either way. A project with progress rows never reaches this.
  const laneCountRow = await db
    .prepare("SELECT COUNT(*) AS target_lanes FROM lanes WHERE project_id = ? AND role = 'target'")
    .bind(projectId)
    .first<{ target_lanes: number | string | null }>()
  const singleLane = Number(laneCountRow?.target_lanes ?? 0) <= 1

  const filesResult = await db
    .prepare(
      // AQU-1626: `files f` aliased so the counted-file rule can apply. A cue
      // sheet or a caption track is machinery, not a deliverable, so it must
      // not be pushed to Monday as a row for a partner to chase.
      `SELECT f.id, f.name, f.cell_count, f.filled_count, f.approved_count,
              f.structural_cell_count, f.structural_filled_count, f.structural_approved_count
         FROM files f
        WHERE f.project_id = ? AND ${countedFileSql('f')}
        ORDER BY f.name ASC`,
    )
    .bind(projectId)
    .all<FileRow>()
  const files = filesResult.results ?? []

  const progressResult = await db
    .prepare(
      // AQU-1599: TARGET lanes only, and only lanes that are still active.
      // The projection also writes a row for the project's source lane — the
      // lane-independent denominator — and the rollup below sums `total_count`
      // over every row it is handed, so including it would add the source-cell
      // count to the board's total a second time. An archived lane's row is
      // the same kind of extra: the board would count work nobody is still
      // planning.
      `SELECT fsp.file_id AS file_id, fsp.total_count AS total_count,
              fsp.filled_count AS filled_count,
              fsp.validator_histogram AS validator_histogram,
              fsp.structural_count AS structural_count,
              fsp.structural_filled_count AS structural_filled_count,
              fsp.structural_validator_histogram AS structural_validator_histogram,
              fsp.audio_validator_histogram AS audio_validator_histogram,
              fsp.structural_audio_validator_histogram AS structural_audio_validator_histogram,
              fsp.audio_count AS audio_count,
              fsp.structural_audio_count AS structural_audio_count
         FROM file_section_progress fsp
         JOIN lanes l
           ON l.project_id = fsp.project_id AND l.id = fsp.lane_id AND l.role = 'target'
          AND l.archived_at IS NULL
        WHERE fsp.project_id = ? AND fsp.scope = 'file'`,
    )
    .bind(projectId)
    .all<ProgressRow>()
  const progressByFile = new Map<string, ProgressRow[]>()
  for (const row of progressResult.results ?? []) {
    const list = progressByFile.get(row.file_id) ?? []
    list.push(row)
    progressByFile.set(row.file_id, list)
  }

  const translatorsResult = await db
    .prepare(
      `SELECT DISTINCT u.username AS username
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ? AND pm.role_level >= ?
        ORDER BY u.username ASC`,
    )
    .bind(projectId, ROLE.CONTRIBUTOR)
    .all<{ username: string }>()
  const translators = (translatorsResult.results ?? []).map((r) => r.username).join(", ")

  let lastActivity = new Date().toISOString().slice(0, 10)
  try {
    const row = await db
      .prepare("SELECT MAX(server_ts) AS last_ts FROM events WHERE project_id = ?")
      .bind(projectId)
      .first<{ last_ts: number | null }>()
    if (row?.last_ts != null && Number(row.last_ts) > 0) {
      lastActivity = new Date(Number(row.last_ts)).toISOString().slice(0, 10)
    }
  } catch {
    // events table unreachable — keep now() (contract fallback).
  }

  // ── Project-wide facts ────────────────────────────────────────────────
  const today = aoeTodayIso(now)
  // The plan board's own unit list and counts (db/shared/plan-units.ts):
  // units_done / units_overdue are exactly the org dashboard's numbers.
  const counts = await db
    .prepare(planUnitCountsSql("f.project_id = ?"))
    .bind(today, projectId)
    .first<{ units_total: number | string; units_done: number | string; units_overdue: number | string }>()
  const unitsResult = await db
    .prepare(
      `SELECT u.file_id, u.file_name, u.section_key, pl.target_date, pl.done_at,
              EXISTS (
                SELECT 1 FROM file_section_progress p
                  JOIN lanes l ON l.project_id = p.project_id AND l.id = p.lane_id
                              AND l.role = 'target' AND l.archived_at IS NULL
                 WHERE p.project_id = u.project_id AND p.file_id = u.file_id
                   AND p.scope = CASE WHEN u.section_key = '' THEN 'file' ELSE 'book' END
                   AND p.section_key = u.section_key
                   AND (p.filled_count > 0 OR p.audio_count > 0)
              ) AS started
         FROM (${planUnitsSql("f.project_id = ?")}) u
         LEFT JOIN plan_units pl
           ON pl.project_id = u.project_id AND pl.file_id = u.file_id AND pl.section_key = u.section_key
        ORDER BY u.file_name, u.section_key`,
    )
    .bind(projectId)
    .all<UnitRow>()
  const units = unitsResult.results ?? []
  const projectPlan = planFacts(units, today)

  const languagesResult = await db
    .prepare(
      `SELECT name, language, role FROM lanes
        WHERE project_id = ? AND role = 'target' AND archived_at IS NULL
        ORDER BY position, id`,
    )
    .bind(projectId)
    .all<{ name: string | null; language: string | null; role: "target" }>()

  let activeContributors = 0
  let daysSinceActivity: number | null = null
  try {
    const activity = await db
      .prepare(
        `SELECT COUNT(DISTINCT author) FILTER (WHERE server_ts >= ?) AS active,
                MAX(server_ts) AS last_ts
           FROM events WHERE project_id = ?`,
      )
      .bind(now - 30 * 24 * 60 * 60 * 1000, projectId)
      .first<{ active: number | string | null; last_ts: number | string | null }>()
    activeContributors = Number(activity?.active ?? 0) || 0
    if (activity?.last_ts != null && Number(activity.last_ts) > 0) {
      daysSinceActivity = Math.max(0, Math.floor((now - Number(activity.last_ts)) / (24 * 60 * 60 * 1000)))
    }
  } catch {
    // events table unreachable — leave the activity columns empty.
  }

  // The org dashboard's "recorded" (org-permissions.ts au_cells): every
  // selected dub take on a file whose recordings count, cue sheets included.
  const recorded = await db
    .prepare(
      `SELECT COALESCE(SUM(a.duration_ms), 0) AS ms
         FROM cell_audio a
        WHERE a.project_id = ? AND a.deleted = 0 AND a.selected = 1 AND a.role = 'dub'
          AND ${inAudioCountedFileSql("a")}`,
    )
    .bind(projectId)
    .first<{ ms: number | string | null }>()

  const facts: ProjectFacts = {
    deadline,
    project_link: `${appBase}/projects/${encodeURIComponent(project.id)}`,
    schedule_status: scheduleStatus(deadline, Number(counts?.units_overdue ?? 0) || 0, now),
    books_done: Number(counts?.units_total ?? 0) > 0
      ? `${Number(counts?.units_done ?? 0)} of ${Number(counts?.units_total ?? 0)}`
      : "",
    next_target_date: projectPlan.next_target_date,
    days_since_activity: daysSinceActivity,
    project_manager: project.pm_name ?? "",
    // The app's own lane label (the name override, else the language); a
    // lane with neither is left out rather than shown as a placeholder.
    languages: (languagesResult.results ?? [])
      .filter((l) => (l.name ?? "").trim() || (l.language ?? "").trim())
      .map((l) => laneDisplayName(l))
      .join(", "),
    active_contributors_30d: activeContributors,
    books_in_progress: projectPlan.books_in_progress,
    recorded_minutes: round1((Number(recorded?.ms ?? 0) || 0) / 60000),
  }
  const unitsByFile = new Map<string, UnitRow[]>()
  for (const unit of units) {
    const list = unitsByFile.get(unit.file_id) ?? []
    list.push(unit)
    unitsByFile.set(unit.file_id, list)
  }
  // A file row keeps the project's facts except where the file has its own:
  // its link opens the file, and its plan columns read its own units.
  const fileFacts = (fileId: string): ProjectFacts => {
    const own = planFacts(unitsByFile.get(fileId) ?? [], today)
    return {
      ...facts,
      project_link: `${appBase}/project/${encodeURIComponent(project.id)}/editor/file/${encodeURIComponent(fileId)}`,
      books_done: own.books_done,
      next_target_date: own.next_target_date,
      books_in_progress: own.books_in_progress,
    }
  }

  const fileEntries: FileMetricsEntry[] = []
  const projectTotals: EntityTotals = { total: 0, filled: 0, validated: 0, audioValidated: 0, hasAudio: 0 }

  for (const file of files) {
    const laneRows = progressByFile.get(file.id) ?? []
    let totals: EntityTotals
    if (laneRows.length > 0) {
      const histogram = new Map<number, number>()
      // AQU-1771: audio has its own histogram (validator counts on the
      // selected dub take, weakest track deciding — db/shared/audio-progress.ts).
      // Audio % used to be read off the TEXT histogram, so it reported text
      // validation under an audio heading.
      const audioHistogram = new Map<number, number>()
      let total = 0
      let filled = 0
      let hasAudio = 0
      for (const lane of laneRows) {
        total += Number(lane.total_count) || 0
        filled += Number(lane.filled_count) || 0
        hasAudio += Number(lane.audio_count) || 0
        const laneHistogram = parseHistogram(lane.validator_histogram)
        const laneAudio = parseHistogram(lane.audio_validator_histogram)
        if (!countStructural) {
          total -= Number(lane.structural_count) || 0
          filled -= Number(lane.structural_filled_count) || 0
          hasAudio -= Number(lane.structural_audio_count) || 0
          subtractHistogram(laneHistogram, lane.structural_validator_histogram)
          subtractHistogram(laneAudio, lane.structural_audio_validator_histogram)
        }
        for (const [bucket, amount] of laneHistogram) {
          histogram.set(bucket, (histogram.get(bucket) ?? 0) + amount)
        }
        for (const [bucket, amount] of laneAudio) {
          audioHistogram.set(bucket, (audioHistogram.get(bucket) ?? 0) + amount)
        }
      }
      totals = {
        total: Math.max(0, total),
        filled: Math.max(0, filled),
        validated: validatedAtThreshold(histogram, threshold),
        audioValidated: validatedAtThreshold(audioHistogram, audioThreshold),
        hasAudio: Math.max(0, hasAudio),
      }
    } else {
      // Pre-backfill fallback: file counters (approved ≈ validated), and only
      // on a single-lane project — see `singleLane` above.
      const less = (n: unknown) => (countStructural ? 0 : Number(n) || 0)
      const total = Math.max(0, (Number(file.cell_count) || 0) - less(file.structural_cell_count))
      totals = singleLane
        ? {
            total,
            filled: Math.max(0, (Number(file.filled_count) || 0) - less(file.structural_filled_count)),
            validated: Math.max(
              0,
              (Number(file.approved_count) || 0) - less(file.structural_approved_count),
            ),
            audioValidated: 0,
            hasAudio: 0,
          }
        : { total, filled: 0, validated: 0, audioValidated: 0, hasAudio: 0 }
    }
    projectTotals.total += totals.total
    projectTotals.filled += totals.filled
    projectTotals.validated += totals.validated
    projectTotals.audioValidated += totals.audioValidated
    projectTotals.hasAudio += totals.hasAudio
    fileEntries.push({
      fileId: file.id,
      fileName: file.name,
      metrics: buildMetrics(totals, translators, lastActivity, fileFacts(file.id)),
    })
  }

  return {
    projectId: project.id,
    projectName: project.name,
    project: buildMetrics(projectTotals, translators, lastActivity, facts),
    files: fileEntries,
  }
}
