// AQU-2145 — the nightly sweep that re-projects files whose progress rows have
// fallen behind their own audio events.
//
// The rows this repairs are derived data: the takes and the validator votes are
// intact in `cell_audio`, and the progress rows are a rollup over them that the
// write path maintains. AQU-2143 fixed the write path that was dropping that
// rollup during a burst, and AQU-2144 repairs the rows the burst already left
// behind. Neither of those detects the NEXT occurrence — the fault was silent on
// production for weeks because nothing in the system compares the rows with the
// log. This sweep is that comparison, run every night.
//
// What it buys is a bound on the damage, not a different fix: a file a burst
// leaves stale reads wrong until the next sweep and right afterwards, so the
// worst case is one morning instead of forever. The second thing it buys is the
// alarm — `repaired=N` on a healthy night is zero, so a nightly line with a
// non-zero count is the signal that the write path has regressed again. Log it,
// don't suppress it.
//
// Bounded, like the two sweeps beside it (r2-gc-cron.ts, AQU-1856;
// projection-snapshot-cron.ts, AQU-1833): the selector is one pass, the
// expensive half is the per-file recompute, and that is what the cap limits. The
// remainder is reported rather than run, so an unhealthy night costs a known
// amount and the next night takes the rest.
//
// No cursor, unlike those two. It does not need one: the selector names exactly
// the files that are still wrong, so a capped run's leftovers are the next run's
// first results by construction, and a repaired file drops out of the selector
// instead of having to be remembered.

import { makePostgres, withLongOperationTimeout } from "../../db/shim/postgres"
import { scheduledDeploymentEnvironmentError } from "./environment-guard"
import {
  audioStaleProgressFilesSql,
  fullProgressRecomputeStmts,
} from "./events/progress-projection"

export interface ProgressSelfHealCronEnv {
  AQUILLA_PG?: AquillaDb
  HYPERDRIVE?: { connectionString: string }
  ENVIRONMENT?: string
  ALLOW_UNAUTHENTICATED?: string
  DEPLOYMENT_WORKER_NAME?: string
  /** `off` skips the sweep. A var rather than a code constant so an operator
   *  can stop it with `wrangler deploy --var` instead of waiting on a release —
   *  a skipped night only means a stale file stays stale one more day. */
  PROGRESS_SELFHEAL_MODE?: string
}

/** Cron expression that owns the sweep. Must match sync-worker/wrangler.toml.
 *  After the 04:41 projection-snapshot sweep, so the two never contend for
 *  Hyperdrive connections on the same minute. */
export const PROGRESS_SELFHEAL_CRON = "29 5 * * *"

/**
 * Files re-projected per run. The cap that bounds the night's cost: each repair
 * is a full per-file aggregate, which on a whole-Bible file is the expensive
 * end of the range.
 *
 * Sized against the fault it exists for rather than against a healthy night
 * (which repairs nothing): AQU-2144 measured the 2026-10-23 production copy at
 * roughly 65 stale files on its worst project, so one night clears several such
 * projects while still being a cost an operator can predict.
 */
export const DEFAULT_MAX_REPAIRS = 200

export interface ProgressSelfHealSweepOptions {
  /** Sweep exactly this project and nothing else — the admin route's
   *  `?projectId=`. Still capped: a single project is what held 65 stale files. */
  onlyProjectId?: string
  maxRepairs?: number
  now?: number
}

export interface ProgressSelfHealSweepReport {
  /** Stale files this run picked up — at most `maxRepairs`. */
  filesSelected: number
  filesRepaired: number
  /**
   * Stale files still outstanding when the run stopped at its cap, counted
   * after the repairs landed, so it is the exact number the next run will take.
   * 0 whenever the run was not capped.
   */
  remaining: number
  repaired: Array<{ projectId: string; fileId: string }>
  errors: string[]
}

interface StaleFileRow {
  project_id: string
  id: string
}

/**
 * Re-project every stale file the selector names, up to the cap.
 *
 * A failure on one file is recorded and the sweep continues: one project's bad
 * file must not cost every other file its night.
 */
export async function sweepStaleAudioProgress(
  env: ProgressSelfHealCronEnv & { AQUILLA_PG: AquillaDb },
  options: ProgressSelfHealSweepOptions = {},
): Promise<ProgressSelfHealSweepReport> {
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS
  const db = withLongOperationTimeout(env.AQUILLA_PG, "progress-selfheal")
  const report: ProgressSelfHealSweepReport = {
    filesSelected: 0,
    filesRepaired: 0,
    remaining: 0,
    repaired: [],
    errors: [],
  }

  const byProject = options.onlyProjectId !== undefined
  const selector = audioStaleProgressFilesSql({ byProject })
  // One row past the cap, purely to learn whether there IS a remainder without
  // counting the whole set on a healthy night. The exact count comes later, and
  // only when this tells us it is worth asking for.
  const binds: unknown[] = byProject ? [options.onlyProjectId] : []
  const { results } = await db
    .prepare(`SELECT project_id, id FROM (${selector}) stale
               ORDER BY project_id, id LIMIT ?`)
    .bind(...binds, maxRepairs + 1)
    .all<StaleFileRow>()
  const selected = (results ?? []).slice(0, maxRepairs)
  const capped = (results ?? []).length > maxRepairs
  report.filesSelected = selected.length

  for (const file of selected) {
    const now = options.now ?? Date.now()
    try {
      // One short transaction per file, exactly as scripts/neon-backfill-progress.ts
      // runs it: the project sequence-row lock is the same serialization point
      // event writes take, so the aggregate cannot read a half-applied burst and
      // write a row that is stale in a new way.
      await db.batch([
        db
          .prepare(
            `INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq)
             SELECT ?, COALESCE(MAX(server_seq), 0), 0 FROM events WHERE project_id = ?
             ON CONFLICT (project_id) DO NOTHING`,
          )
          .bind(file.project_id, file.project_id),
        db
          .prepare("SELECT project_id FROM project_seq_counters WHERE project_id = ? FOR UPDATE")
          .bind(file.project_id),
        ...fullProgressRecomputeStmts(db, file.project_id, file.id, now),
      ])
      report.filesRepaired += 1
      report.repaired.push({ projectId: file.project_id, fileId: file.id })
    } catch (err) {
      report.errors.push(`${file.project_id}/${file.id}: ${String(err)}`)
    }
  }

  if (capped) {
    // Asked AFTER the repairs, so the answer is what is left rather than what
    // was there — the number the next run will actually take.
    const row = await db
      .prepare(`SELECT COUNT(*)::int AS remaining FROM (${selector}) stale`)
      .bind(...binds)
      .first<{ remaining: number }>()
    report.remaining = Number(row?.remaining ?? 0)
  }
  return report
}

export function formatProgressSelfHealReport(report: ProgressSelfHealSweepReport): string {
  const parts = [
    `selected=${report.filesSelected}`,
    `repaired=${report.filesRepaired}`,
    `remaining=${report.remaining}`,
    report.errors.length ? `errors=${report.errors.length}` : "",
  ].filter(Boolean)
  return parts.join(" ")
}

/**
 * Run one sweep, building a request-scoped Postgres handle if the caller has not
 * supplied one.
 *
 * Returns null when the sweep was skipped (disabled, no database, or refused by
 * the cross-environment guard), so a caller can tell "did not run" from
 * "repaired nothing" — which on this sweep are the two answers it is most
 * important not to confuse: a healthy night and a dead cron log the same count.
 */
export async function runProgressSelfHealSweep(
  env: ProgressSelfHealCronEnv,
  options: ProgressSelfHealSweepOptions = {},
): Promise<ProgressSelfHealSweepReport | null> {
  if (env.PROGRESS_SELFHEAL_MODE?.trim().toLowerCase() === "off") {
    console.log("[progress-selfheal] PROGRESS_SELFHEAL_MODE=off — skipping")
    return null
  }
  const environmentError = scheduledDeploymentEnvironmentError(env)
  if (environmentError) {
    // A development-profile worker bound to the production database would
    // rewrite production's progress rows from an unattended cron.
    console.error("[progress-selfheal] refusing to run with cross-environment bindings", {
      environmentError,
    })
    return null
  }

  let shim: { close(): Promise<void> } | null = null
  let runEnv = env
  if (!env.AQUILLA_PG) {
    if (!env.HYPERDRIVE) {
      console.error("[progress-selfheal] HYPERDRIVE not bound — skipping sweep")
      return null
    }
    shim = makePostgres(env.HYPERDRIVE.connectionString)
    runEnv = { ...env, AQUILLA_PG: shim as unknown as AquillaDb }
  }
  try {
    const report = await sweepStaleAudioProgress(
      runEnv as ProgressSelfHealCronEnv & { AQUILLA_PG: AquillaDb },
      options,
    )
    console.log(`[progress-selfheal] ${formatProgressSelfHealReport(report)}`)
    for (const err of report.errors) console.error(`[progress-selfheal] ${err}`)
    return report
  } finally {
    if (shim) await shim.close()
  }
}
