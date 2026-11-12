// AQU-2345 — repair the provenance of the files a source link brought into a
// project: the type they were imported as, and a pointer at the upstream's
// original. The two rules, and the whole-project sweep that applies them, live
// in db/shared/link-file-provenance.ts; every link sync runs that sweep
// (AQU-2438), and this module is the on-demand way to run it for one project
// or for all of them — `POST /admin/link-provenance` (admin.ts), the backfill
// for a project nobody has opened since. Nothing here touches a translation or
// a validation: it writes `files.kind`, `files.role` and `files.book_code`
// where they are NULL, and `file_source_blobs` rows, and it reports what it
// did.
//
// It also gives the copies' SOURCE cells the import envelope a link did not
// carry before AQU-1520 (link-envelope.ts) — the third thing an IDML copy needs
// before it can be exported, and the one the first two made reachable. That
// one is an event per cell (`source.cell.metadata.patch`), filling only cells
// whose `metadata` is NULL.
//
// The pairing (in the shared sweep) is the one the detach snapshot uses
// (auth-worker snapshotSourceFiles): `meta.upstreamFileId`, the stamp every
// copy made since AQU-1547 carries, else the deterministic id a live mirror
// gives its copies, which covers rows mirrored before the stamp. A file
// matching neither is the project's own — an import of its own, or (AQU-1679)
// a file adopted under the link — and is reported, not touched.

import { makePostgres } from '../../../db/shim/postgres'
import { parseSourceLinkAdoption } from '../../../db/shared/source-link-adopt'
import { applyProjectLinkedFileProvenance } from '../../../db/shared/link-file-provenance'
import { scheduledDeploymentEnvironmentError } from '../environment-guard'
import { repairMirroredCellEnvelopes } from './link-envelope'
import { deterministicDownstreamFileId, deterministicMirrorEventId, loadLink } from './link-sync'

export interface LinkProvenanceReport {
  projectId: string
  upstreamProjectId: string
  mode: string | null
  dryRun: boolean
  /** Copies paired with an upstream file. */
  filesPaired: number
  /** Copies whose NULL type columns were (or, dry, would be) filled. */
  typeRepaired: number
  /** Copies whose pointer row was (or would be) written. */
  blobPointersWritten: number
  /** Copies whose upstream file has no original of its own to point at. */
  noUpstreamBlob: number
  /** Cells of those copies given (or, dry, lacking) the upstream's import
   *  envelope — copies mirrored before AQU-1520 (link-envelope.ts). */
  envelopesRepaired: number
  /** Live files that are the project's own — adopted under the link, or
   *  imported by the project itself. Left alone. */
  ownFiles: string[]
}

/** Rounds of the envelope repair one project gets per run: 200,000 cells, a
 *  ceiling on a runaway rather than a size anything real reaches. */
const MAX_ENVELOPE_ROUNDS = 200

export interface LinkProvenanceOptions {
  dryRun?: boolean
  now?: number
}

/**
 * Repair one linked project. `null` when it has no source link: a detached
 * project keeps `meta.upstreamFileId` on its copies but no longer names the
 * project they came from, so there is nothing to pair them with.
 */
export async function repairLinkedFileProvenance(
  db: AquillaDb,
  downstreamProjectId: string,
  options: LinkProvenanceOptions = {},
): Promise<LinkProvenanceReport | null> {
  const link = await loadLink(db, downstreamProjectId)
  if (!link?.source_project_id) return null
  const upstreamProjectId = link.source_project_id
  const dryRun = options.dryRun ?? false
  const now = options.now ?? Date.now()

  const adoption = parseSourceLinkAdoption(link.source_link_adopt)

  // AQU-2438: the pairing and both rules are the shared whole-project sweep
  // every link sync now runs (db/shared/link-file-provenance.ts) — this route
  // is the on-demand way to run it, not a second implementation of it, so the
  // backfill and the per-sync repair cannot drift apart.
  const { plan, pairs, ownFileIds: ownFiles } = await applyProjectLinkedFileProvenance(db, {
    upstreamProjectId,
    downstreamProjectId,
    downstreamFileIdOf: (upstreamFileId) =>
      deterministicDownstreamFileId(downstreamProjectId, upstreamFileId),
    adoption,
    now,
    dryRun,
  })
  // The cells of those copies: the import envelope a link did not carry before
  // AQU-1520. Not for a link that consumes the upstream's TARGET, whose source
  // text the upstream's envelope does not describe. Bounded per call like the
  // per-sync repair, so a project is finished over a few rounds.
  let envelopesRepaired = 0
  if (link.source_link_consumes !== 'target') {
    for (let round = 0; round < MAX_ENVELOPE_ROUNDS; round++) {
      const envelopes = await repairMirroredCellEnvelopes(db, {
        upstreamProjectId,
        downstreamProjectId,
        pairs,
        eventId: (key) => deterministicMirrorEventId(downstreamProjectId, key),
        author: 'link-sync',
        now,
        dryRun,
      })
      envelopesRepaired += envelopes.repaired
      if (!envelopes.more) break
    }
  }
  return {
    projectId: downstreamProjectId,
    upstreamProjectId,
    mode: link.source_link_mode,
    dryRun,
    envelopesRepaired,
    filesPaired: pairs.length,
    typeRepaired: plan.typeRepairs.length,
    blobPointersWritten: plan.blobPointers.length,
    noUpstreamBlob: plan.noUpstreamBlob.length,
    ownFiles,
  }
}

export interface LinkProvenanceSweepReport {
  dryRun: boolean
  projects: LinkProvenanceReport[]
  /** Projects the sweep could not repair; the rest of the run went on. */
  errors: string[]
}

/** Every project that names a source project, one report each. */
export async function repairAllLinkedFileProvenance(
  db: AquillaDb,
  options: LinkProvenanceOptions = {},
): Promise<LinkProvenanceSweepReport> {
  const report: LinkProvenanceSweepReport = { dryRun: options.dryRun ?? false, projects: [], errors: [] }
  const linked = await db
    .prepare(`SELECT id FROM projects WHERE source_project_id IS NOT NULL ORDER BY id`)
    .all<{ id: string }>()
  for (const { id } of linked.results) {
    try {
      const one = await repairLinkedFileProvenance(db, id, options)
      if (one) report.projects.push(one)
    } catch (err) {
      report.errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return report
}

export function formatLinkProvenanceSweep(report: LinkProvenanceSweepReport): string {
  const sum = (pick: (r: LinkProvenanceReport) => number) => report.projects.reduce((n, r) => n + pick(r), 0)
  return (
    `${report.dryRun ? 'dry run: ' : ''}projects=${report.projects.length} ` +
    `paired=${sum((r) => r.filesPaired)} typeRepaired=${sum((r) => r.typeRepaired)} ` +
    `pointers=${sum((r) => r.blobPointersWritten)} noUpstreamBlob=${sum((r) => r.noUpstreamBlob)} ` +
    `envelopes=${sum((r) => r.envelopesRepaired)} ` +
    `own=${sum((r) => r.ownFiles.length)} errors=${report.errors.length}`
  )
}

export interface LinkProvenanceEnv {
  AQUILLA_PG?: AquillaDb
  HYPERDRIVE?: { connectionString: string }
  ENVIRONMENT?: string
  ALLOW_UNAUTHENTICATED?: string
  DEPLOYMENT_WORKER_NAME?: string
}

/**
 * The admin entrypoint. One project with `onlyProjectId` (a project without a
 * link reports as an empty sweep), else every linked project. `null` when the
 * worker has no database to reach, or is bound across environments — the same
 * refusal the nightly sweeps make, for the same reason: a development-profile
 * worker must not write production's rows.
 */
export async function runLinkProvenanceRepair(
  env: LinkProvenanceEnv,
  options: LinkProvenanceOptions & { onlyProjectId?: string } = {},
): Promise<LinkProvenanceSweepReport | null> {
  const environmentError = scheduledDeploymentEnvironmentError(env)
  if (environmentError) {
    console.error('[link-provenance] refusing to run with cross-environment bindings', { environmentError })
    return null
  }
  let shim: { close(): Promise<void> } | null = null
  let db = env.AQUILLA_PG ?? null
  if (!db) {
    if (!env.HYPERDRIVE) {
      console.error('[link-provenance] HYPERDRIVE not bound — skipping')
      return null
    }
    shim = makePostgres(env.HYPERDRIVE.connectionString)
    db = shim as unknown as AquillaDb
  }
  try {
    let report: LinkProvenanceSweepReport
    if (options.onlyProjectId) {
      const one = await repairLinkedFileProvenance(db, options.onlyProjectId, options)
      report = { dryRun: options.dryRun ?? false, projects: one ? [one] : [], errors: [] }
    } else {
      report = await repairAllLinkedFileProvenance(db, options)
    }
    console.log(`[link-provenance] ${formatLinkProvenanceSweep(report)}`)
    for (const err of report.errors) console.error(`[link-provenance] ${err}`)
    return report
  } finally {
    if (shim) await shim.close()
  }
}
