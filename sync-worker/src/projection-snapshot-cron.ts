// AQU-1833 — the nightly entrypoint that keeps projection snapshots fresh.
//
// Snapshot writes stay OFF the request path: a snapshot of a large project
// reads its whole `cells` table, which is exactly the work a rebuild exists to
// avoid doing while someone waits. So they happen here, and on demand through
// `POST /admin/projection-snapshot` (admin.ts) when an operator wants one now.
//
// The sweep is bounded twice over — `maxProjects` candidates considered and
// `maxSnapshots` written per run — and resumable from a cursor persisted in the
// bucket, so successive nights cover every project and a run that dies costs at
// most one night's progress. Same shape as the AQU-1856 R2 orphan sweep
// (r2-gc-cron.ts), for the same reasons.
//
// Candidates come from `project_seq_counters.last_seq`, the per-project
// high-water mark the write path already maintains — not from an aggregate over
// `events`, which would scan the one table this feature exists to stop
// scanning.

import { makePostgres, withLongOperationTimeout } from "../../db/shim/postgres"
import { scheduledDeploymentEnvironmentError } from "./environment-guard"
import { r2KeyPrefix } from "./audio"
import {
  readProjectionSnapshot,
  writeProjectionSnapshot,
  SNAPSHOT_MIN_NEW_EVENTS,
  type ProjectionSnapshotEnv,
} from "./events/projection-snapshot"

export interface ProjectionSnapshotCronEnv extends ProjectionSnapshotEnv {
  AQUILLA_PG?: AquillaDb
  HYPERDRIVE?: { connectionString: string }
  ENVIRONMENT?: string
  ALLOW_UNAUTHENTICATED?: string
  DEPLOYMENT_WORKER_NAME?: string
  /** `off` skips the sweep. A var rather than a code constant so an operator
   *  can stop it with `wrangler deploy --var` instead of waiting on a release. */
  PROJECTION_SNAPSHOT_MODE?: string
}

/** Cron expression that owns the sweep. Must match sync-worker/wrangler.toml. */
export const PROJECTION_SNAPSHOT_CRON = "41 4 * * *"

/** Projects whose high-water mark is read per run. */
export const DEFAULT_MAX_PROJECTS = 50
/** Snapshots actually written per run. The cap that bounds the run's cost. */
export const DEFAULT_MAX_SNAPSHOTS = 5

export interface ProjectionSnapshotSweepOptions {
  /** Snapshot exactly this project and nothing else, ignoring the cursor and
   *  the per-run caps. The admin route's `?projectId=`. */
  onlyProjectId?: string
  maxProjects?: number
  maxSnapshots?: number
  minNewEvents?: number
  /** Resume point: the last project id the previous run finished. */
  cursor?: string
  now?: number
}

export interface ProjectionSnapshotSweepReport {
  projectsConsidered: number
  snapshotsWritten: number
  /** Considered but not written: already current enough, or the project took a
   *  write while its rows were being read (see writeProjectionSnapshot). */
  skippedCurrent: number
  written: Array<{ projectId: string; snapshotSeq: number; cells: number; validators: number }>
  errors: string[]
  /** Where the next run resumes, or undefined once the walk wrapped around. */
  nextCursor?: string
}

function cursorKey(env: Pick<ProjectionSnapshotCronEnv, "R2_KEY_PREFIX">): string {
  return `${r2KeyPrefix(env)}projection-snapshots/cron-cursor.json`
}

/** Read the project id the last run stopped at. A missing or corrupt cursor
 *  just means "start from the top" — never a reason to fail the sweep. */
export async function readSnapshotCursor(
  env: ProjectionSnapshotCronEnv,
): Promise<string | undefined> {
  try {
    const obj = await env.SNAPSHOTS.get(cursorKey(env))
    if (!obj) return undefined
    const parsed = JSON.parse(await obj.text()) as unknown
    const project = (parsed as { project?: unknown })?.project
    return typeof project === "string" && project !== "" ? project : undefined
  } catch {
    return undefined
  }
}

export async function writeSnapshotCursor(
  env: ProjectionSnapshotCronEnv,
  project: string | undefined,
): Promise<void> {
  try {
    await env.SNAPSHOTS.put(cursorKey(env), JSON.stringify({ project: project ?? "" }), {
      httpMetadata: { contentType: "application/json" },
    })
  } catch (err) {
    // Losing the cursor re-walks ground already covered, which is wasteful but
    // harmless — never worth failing the run over.
    console.warn("[projection-snapshot] could not persist cursor:", err)
  }
}

interface CandidateRow {
  project_id: string
  last_seq: number | string | bigint
}

/**
 * Consider up to `maxProjects` projects from the cursor on, and snapshot the
 * ones that have moved at least `minNewEvents` past their last snapshot.
 *
 * A failure on one project is recorded and the sweep continues: one project's
 * bad snapshot must not cost every other project its night.
 */
export async function sweepProjectionSnapshots(
  env: ProjectionSnapshotCronEnv & { AQUILLA_PG: AquillaDb },
  options: ProjectionSnapshotSweepOptions = {},
): Promise<ProjectionSnapshotSweepReport> {
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS
  const maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS
  const minNewEvents = options.minNewEvents ?? SNAPSHOT_MIN_NEW_EVENTS
  const db = withLongOperationTimeout(env.AQUILLA_PG, "projection-snapshot")
  const report: ProjectionSnapshotSweepReport = {
    projectsConsidered: 0,
    snapshotsWritten: 0,
    skippedCurrent: 0,
    written: [],
    errors: [],
  }

  let candidates: CandidateRow[]
  if (options.onlyProjectId) {
    const row = await db
      .prepare("SELECT project_id, last_seq FROM project_seq_counters WHERE project_id = ?")
      .bind(options.onlyProjectId)
      .first<CandidateRow>()
    // A project with no counter row has never had an event allocated, so there
    // is nothing to snapshot — and writeProjectionSnapshot would skip it too.
    candidates = row ? [row] : []
  } else {
    const { results } = await db
      .prepare(
        `SELECT project_id, last_seq FROM project_seq_counters
         WHERE project_id > ? ORDER BY project_id LIMIT ?`,
      )
      .bind(options.cursor ?? "", maxProjects)
      .all<CandidateRow>()
    candidates = results ?? []
  }

  let stoppedEarly = false
  for (const candidate of candidates) {
    if (!options.onlyProjectId && report.snapshotsWritten >= maxSnapshots) {
      // The per-run write cap. Leave the cursor on the last project actually
      // handled so tomorrow resumes HERE rather than skipping the remainder.
      stoppedEarly = true
      break
    }
    report.projectsConsidered += 1
    const lastSeq = Number(candidate.last_seq ?? 0)
    try {
      const existing = await readProjectionSnapshot(env, candidate.project_id)
      if (existing && lastSeq - existing.snapshotSeq < minNewEvents) {
        report.skippedCurrent += 1
        continue
      }
      const result = await writeProjectionSnapshot(env, db, candidate.project_id, {
        minNewEvents,
        now: options.now,
      })
      if (!result) {
        report.skippedCurrent += 1
        continue
      }
      report.snapshotsWritten += 1
      report.written.push({
        projectId: candidate.project_id,
        snapshotSeq: result.manifest.snapshotSeq,
        cells: result.manifest.counts.cells,
        validators: result.manifest.counts.cell_validators,
      })
    } catch (err) {
      report.errors.push(`${candidate.project_id}: ${String(err)}`)
    } finally {
      // A single-project run is out-of-band: it must not move the nightly
      // walk's resume point.
      if (!options.onlyProjectId) report.nextCursor = candidate.project_id
    }
  }

  // Fewer candidates than asked for, and none left unhandled, means the walk
  // reached the end of the table: clear the cursor so the next run starts over
  // from the top.
  if (!options.onlyProjectId && !stoppedEarly && candidates.length < maxProjects) {
    report.nextCursor = undefined
  }
  return report
}

export function formatProjectionSnapshotReport(report: ProjectionSnapshotSweepReport): string {
  const parts = [
    `considered=${report.projectsConsidered}`,
    `written=${report.snapshotsWritten}`,
    `current=${report.skippedCurrent}`,
    report.errors.length ? `errors=${report.errors.length}` : "",
    report.nextCursor ? `nextCursor=${report.nextCursor}` : "nextCursor=(wrapped)",
  ].filter(Boolean)
  return parts.join(" ")
}

/**
 * Run one sweep, building a request-scoped Postgres handle if the caller has
 * not supplied one.
 *
 * Returns null when the sweep was skipped (disabled, no database, or refused by
 * the cross-environment guard), so a caller can tell "nothing to do" from
 * "snapshotted nothing".
 */
export async function runProjectionSnapshotSweep(
  env: ProjectionSnapshotCronEnv,
  options: ProjectionSnapshotSweepOptions = {},
): Promise<ProjectionSnapshotSweepReport | null> {
  if (env.PROJECTION_SNAPSHOT_MODE?.trim().toLowerCase() === "off") {
    console.log("[projection-snapshot] PROJECTION_SNAPSHOT_MODE=off — skipping")
    return null
  }
  const environmentError = scheduledDeploymentEnvironmentError(env)
  if (environmentError) {
    // A snapshot written with one environment's database into another's bucket
    // is a rebuild that silently restores the wrong project's rows.
    console.error("[projection-snapshot] refusing to run with cross-environment bindings", {
      environmentError,
    })
    return null
  }

  let shim: { close(): Promise<void> } | null = null
  let runEnv = env
  if (!env.AQUILLA_PG) {
    if (!env.HYPERDRIVE) {
      console.error("[projection-snapshot] HYPERDRIVE not bound — skipping sweep")
      return null
    }
    shim = makePostgres(env.HYPERDRIVE.connectionString)
    runEnv = { ...env, AQUILLA_PG: shim as unknown as AquillaDb }
  }
  try {
    const cursor = options.onlyProjectId
      ? undefined
      : (options.cursor ?? (await readSnapshotCursor(env)))
    const report = await sweepProjectionSnapshots(
      runEnv as ProjectionSnapshotCronEnv & { AQUILLA_PG: AquillaDb },
      { ...options, ...(cursor === undefined ? {} : { cursor }) },
    )
    if (!options.onlyProjectId) await writeSnapshotCursor(env, report.nextCursor)
    console.log(`[projection-snapshot] ${formatProjectionSnapshotReport(report)}`)
    for (const err of report.errors) console.error(`[projection-snapshot] ${err}`)
    return report
  } finally {
    if (shim) await shim.close()
  }
}
