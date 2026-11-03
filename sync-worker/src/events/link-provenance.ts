// AQU-2345 — repair the provenance of the files a source link brought into a
// project: the type they were imported as, and a pointer at the upstream's
// original. The two rules live in db/shared/link-file-provenance.ts and every
// mirror window applies them to the files it touches; this module applies them
// to a WHOLE project, for `POST /admin/link-provenance` (admin.ts) — the
// backfill for files linked before the mirror carried either. Nothing here
// touches a cell, a translation or a validation: it writes `files.kind`,
// `files.role` and `files.book_code` where they are NULL, and
// `file_source_blobs` rows.
//
// The pairing is the one the detach snapshot uses (auth-worker
// snapshotSourceFiles): `meta.upstreamFileId`, the stamp every copy made since
// AQU-1547 carries, else the deterministic id a live mirror gives its copies,
// which covers rows mirrored before the stamp. A file matching neither is the
// project's own — an import of its own, or (AQU-1679) a file adopted under the
// link — and is reported, not touched.

import { makePostgres } from '../../../db/shim/postgres'
import { parseSourceLinkAdoption } from '../../../db/shared/source-link-adopt'
import {
  applyLinkedFileProvenance,
  type LinkedFilePair,
} from '../../../db/shared/link-file-provenance'
import { scheduledDeploymentEnvironmentError } from '../environment-guard'
import { deterministicDownstreamFileId, loadLink, parseMetaObject } from './link-sync'

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
  /** Live files that are the project's own — adopted under the link, or
   *  imported by the project itself. Left alone. */
  ownFiles: string[]
}

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
  const adoptedOwnIds = new Set(Object.values(adoption?.files ?? {}))

  // Every upstream file, Recently deleted included: a copy of a file the
  // upstream has since set aside is still that file's material, and the
  // upstream's original row outlives the tombstone.
  const upstreamRows = await db
    .prepare(`SELECT id FROM files WHERE project_id = ?`)
    .bind(upstreamProjectId)
    .all<{ id: string }>()
  const upstreamIds = new Set(upstreamRows.results.map((r) => r.id))
  const upstreamOfMirroredId = new Map<string, string>()
  for (const id of upstreamIds) upstreamOfMirroredId.set(deterministicDownstreamFileId(downstreamProjectId, id), id)

  const copies = await db
    .prepare(`SELECT id, meta FROM files WHERE project_id = ? AND deleted_at IS NULL`)
    .bind(downstreamProjectId)
    .all<{ id: string; meta: string | null }>()
  const pairs: LinkedFilePair[] = []
  const ownFiles: string[] = []
  for (const row of copies.results) {
    if (adoptedOwnIds.has(row.id)) {
      ownFiles.push(row.id)
      continue
    }
    const stamped = parseMetaObject(row.meta).upstreamFileId
    const upstreamFileId =
      typeof stamped === 'string' && upstreamIds.has(stamped)
        ? stamped
        : upstreamOfMirroredId.get(row.id)
    if (!upstreamFileId) {
      ownFiles.push(row.id)
      continue
    }
    pairs.push({ upstreamFileId, downstreamFileId: row.id })
  }

  const plan = await applyLinkedFileProvenance(db, {
    upstreamProjectId,
    downstreamProjectId,
    pairs,
    now,
    dryRun,
  })
  return {
    projectId: downstreamProjectId,
    upstreamProjectId,
    mode: link.source_link_mode,
    dryRun,
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
