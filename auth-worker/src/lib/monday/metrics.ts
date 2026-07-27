// Project metrics for the Monday push engine + AI analyze context.
//
// Sources (shared Postgres — the sync worker maintains these projections):
//   * file_section_progress (scope='file') — totals/filled + validator
//     histogram per (file, lane). Aggregated across all lanes (v1), falling
//     back to files.cell_count/filled_count/approved_count when a file has no
//     progress rows yet (pre-backfill).
//   * project_settings.validation_count (generated column) and the
//     validationCountAudio key for validation thresholds. Same thresholding as
//     sync-worker's progress-read-route: a cell counts as validated when its
//     endorsement bucket >= threshold.
//   * project_members (role >= CONTRIBUTOR 400) joined to users — v1
//     approximation of "translators".
//   * events.server_ts max — last activity (UTC date-only); now() if the
//     events table is unreachable.

import { ROLE } from "../../types"

export interface MondayEntityMetrics {
  completion_pct: number
  validated_pct: number
  audio_validated_pct: number
  filled_count: number
  total_count: number
  validated_count: number
  translators: string
  last_activity: string // 'YYYY-MM-DD' UTC
  status_auto: "Not started" | "In progress" | "Complete"
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
}

interface ProgressRow {
  file_id: string
  total_count: number
  filled_count: number
  validator_histogram: unknown
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

function buildMetrics(
  totals: { total: number; filled: number; validated: number; audioValidated: number },
  translators: string,
  lastActivity: string,
): MondayEntityMetrics {
  const { total, filled, validated, audioValidated } = totals
  const completionPct = total > 0 ? round1((filled / total) * 100) : 0
  return {
    completion_pct: completionPct,
    validated_pct: total > 0 ? round1((validated / total) * 100) : 0,
    audio_validated_pct: total > 0 ? round1((audioValidated / total) * 100) : 0,
    filled_count: filled,
    total_count: total,
    validated_count: validated,
    translators,
    last_activity: lastActivity,
    status_auto: filled <= 0 ? "Not started" : completionPct >= 100 ? "Complete" : "In progress",
  }
}

function toThreshold(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** Compute project + per-file metrics. Returns null if the project doesn't exist. */
export async function computeProjectMetrics(
  db: AquillaDb,
  projectId: string,
): Promise<ProjectMetricsSummary | null> {
  const project = await db
    .prepare("SELECT id, name FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string; name: string }>()
  if (!project) return null

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
  const threshold = toThreshold(settings?.validation_count, 1)
  const audioThreshold = toThreshold(settings?.validation_count_audio, threshold)

  const filesResult = await db
    .prepare(
      `SELECT id, name, cell_count, filled_count, approved_count
         FROM files
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`,
    )
    .bind(projectId)
    .all<FileRow>()
  const files = filesResult.results ?? []

  const progressResult = await db
    .prepare(
      `SELECT file_id, total_count, filled_count, validator_histogram
         FROM file_section_progress
        WHERE project_id = ? AND scope = 'file'`,
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

  const fileEntries: FileMetricsEntry[] = []
  const projectTotals = { total: 0, filled: 0, validated: 0, audioValidated: 0 }

  for (const file of files) {
    const laneRows = progressByFile.get(file.id) ?? []
    let totals: { total: number; filled: number; validated: number; audioValidated: number }
    if (laneRows.length > 0) {
      const histogram = new Map<number, number>()
      let total = 0
      let filled = 0
      for (const lane of laneRows) {
        total += Number(lane.total_count) || 0
        filled += Number(lane.filled_count) || 0
        for (const [bucket, amount] of parseHistogram(lane.validator_histogram)) {
          histogram.set(bucket, (histogram.get(bucket) ?? 0) + amount)
        }
      }
      totals = {
        total,
        filled,
        validated: validatedAtThreshold(histogram, threshold),
        audioValidated: validatedAtThreshold(histogram, audioThreshold),
      }
    } else {
      // Pre-backfill fallback: file counters (approved ≈ validated).
      totals = {
        total: Number(file.cell_count) || 0,
        filled: Number(file.filled_count) || 0,
        validated: Number(file.approved_count) || 0,
        audioValidated: 0,
      }
    }
    projectTotals.total += totals.total
    projectTotals.filled += totals.filled
    projectTotals.validated += totals.validated
    projectTotals.audioValidated += totals.audioValidated
    fileEntries.push({
      fileId: file.id,
      fileName: file.name,
      metrics: buildMetrics(totals, translators, lastActivity),
    })
  }

  return {
    projectId: project.id,
    projectName: project.name,
    project: buildMetrics(projectTotals, translators, lastActivity),
    files: fileEntries,
  }
}
