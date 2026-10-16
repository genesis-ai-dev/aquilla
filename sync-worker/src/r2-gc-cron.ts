// AQU-1856 — the nightly entrypoint for the R2 orphan sweep in r2-gc.ts.
//
// sync-worker had no `scheduled` handler before this; the sweep lives here
// rather than in auth-worker (which owns the repo's other crons) because the
// SNAPSHOTS bucket is only bound to this worker.
//
// The sweep is bounded per run (see r2-gc.ts), so one night does not have to
// cover the whole bucket. The cursor it stops at is persisted in the bucket
// itself, under a `gc/` prefix the sweep deliberately does not recognize, and
// read back on the next run — so successive nights walk the whole bucket and a
// run that dies mid-way costs at most one night's progress.

import { makePostgres } from "../../db/shim/postgres"
import { scheduledDeploymentEnvironmentError } from "./environment-guard"
import {
  formatR2GcReport,
  sweepOrphanedR2Objects,
  type R2GcCursors,
  type R2GcOptions,
  type R2GcReport,
} from "./r2-gc"
import { r2KeyPrefix } from "./audio"

export interface R2GcCronEnv {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
  HYPERDRIVE?: { connectionString: string }
  R2_KEY_PREFIX?: string
  ENVIRONMENT?: string
  ALLOW_UNAUTHENTICATED?: string
  DEPLOYMENT_WORKER_NAME?: string
  /**
   * `off` skips the sweep entirely, `dry-run` reports without deleting, and
   * anything else (including unset) sweeps. A var rather than a code constant
   * so an operator can stop or shadow the sweep with `wrangler deploy --var`
   * instead of waiting on a release.
   */
  R2_GC_MODE?: string
}

/** Cron expression that owns the sweep. Must match sync-worker/wrangler.toml. */
export const R2_GC_CRON = "17 3 * * *"

function cursorKey(env: Pick<R2GcCronEnv, "R2_KEY_PREFIX">): string {
  return `${r2KeyPrefix(env)}gc/r2-gc-cursor.json`
}

/** Read the cursor the last run stopped at. A missing or corrupt object just
 *  means "start from the top" — never a reason to fail the sweep. */
export async function readGcCursors(env: R2GcCronEnv): Promise<R2GcCursors> {
  try {
    const obj = await env.SNAPSHOTS.get(cursorKey(env))
    if (!obj) return {}
    const parsed = JSON.parse(await obj.text()) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    const { projects, artifacts } = parsed as Record<string, unknown>
    return {
      ...(typeof projects === "string" ? { projects } : {}),
      ...(typeof artifacts === "string" ? { artifacts } : {}),
    }
  } catch {
    return {}
  }
}

export async function writeGcCursors(env: R2GcCronEnv, cursors: R2GcCursors): Promise<void> {
  try {
    await env.SNAPSHOTS.put(cursorKey(env), JSON.stringify(cursors), {
      httpMetadata: { contentType: "application/json" },
    })
  } catch (err) {
    // Losing the cursor re-sweeps ground already covered, which is wasteful but
    // harmless — never worth failing the run over.
    console.warn("[r2-gc] could not persist cursor:", err)
  }
}

/**
 * Run one sweep: build a request-scoped Postgres handle if the caller has not
 * supplied one, sweep, persist the cursor, and log a digest.
 *
 * Returns null when the sweep was skipped (disabled, or refused by the
 * cross-environment guard), so a caller can tell "nothing to do" from "swept
 * nothing".
 */
export async function runR2GcSweep(
  env: R2GcCronEnv,
  options: R2GcOptions = {},
): Promise<R2GcReport | null> {
  const mode = env.R2_GC_MODE?.trim().toLowerCase()
  if (mode === "off") {
    console.log("[r2-gc] R2_GC_MODE=off — skipping")
    return null
  }
  const environmentError = scheduledDeploymentEnvironmentError(env)
  if (environmentError) {
    // This sweep deletes media. A profile/binding mismatch is exactly the
    // situation where it could delete the WRONG environment's media.
    console.error("[r2-gc] refusing to sweep with cross-environment bindings", {
      environmentError,
    })
    return null
  }

  const dryRun = options.dryRun ?? mode === "dry-run"
  let shim: { close(): Promise<void> } | null = null
  let runEnv = env
  if (!env.AQUILLA_PG) {
    if (!env.HYPERDRIVE) {
      console.error("[r2-gc] HYPERDRIVE not bound — skipping sweep")
      return null
    }
    shim = makePostgres(env.HYPERDRIVE.connectionString)
    runEnv = { ...env, AQUILLA_PG: shim as unknown as AquillaDb }
  }
  try {
    const cursors = options.cursors ?? (await readGcCursors(env))
    const report = await sweepOrphanedR2Objects(runEnv, { ...options, dryRun, cursors })
    // Persist on a dry run too: a dry run is still progress through the bucket,
    // and re-reporting the same first N projects every night hides the rest.
    await writeGcCursors(env, report.nextCursors)
    console.log(`[r2-gc] ${formatR2GcReport(report)}`)
    for (const err of report.errors) console.error(`[r2-gc] ${err}`)
    return report
  } finally {
    if (shim) await shim.close()
  }
}
