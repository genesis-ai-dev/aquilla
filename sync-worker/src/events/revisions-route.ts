// POST /api/v1/projects/:projectId/files/:fileId/revisions   (AQU-2459)
//
// Write one revision of a file's source side: the client (or, later, a
// connector) sends the parsed units for one artifact; this route aligns them
// against the file's head revision (db/shared/file-revision.ts), writes the
// manifest to R2, ONE `file.revision` event, the index row, and the `cells`
// source rows set-based. No per-cell events, no chain claims.
//
// A file with no revisions yet is ADOPTED first: revision 1 is written from
// its current source cells with their ids and event ids untouched, so a legacy
// file joins the chain without a single cell changing identity. A fresh file
// (no cells) skips adoption and the incoming units become revision 1.
//
// Idempotent: the same artifact + stamp + options as the head is a no-op.
// Auth mirrors source-upload-route.ts — sync JWT scoped to the file, role >=
// PROJECT_LEAD. Returns null when the path/method does not match.

import { withCors } from '../cors'
import { r2KeyPrefix, type AudioEnv } from '../audio'
import { verifyTokenForDoc } from '../auth'
import { ROLE } from './role-policy'
import { readTextBodyWithLimit } from '../../../shared/http-body-limit'
import { MAX_IMPORT_REQUEST_BODY_BYTES } from '../../../shared/import-contract'
import { withLongOperationTimeout } from '../../../db/shim/postgres'
import { notifyProjectDoFileProgressChanged } from '../project-progress-broadcast'
import {
  alignRevision,
  optionsHash as hashOptions,
  uuidV5,
  type RevisionDelta,
  type RevisionUnitInput,
} from '../../../db/shared/file-revision'
import { allocateSeqRange, buildBulkEventInsertStmt, buildSettleSeqRangeStmt } from './event-insert'
import { buildEventProjectionStmts, fileCountersRecomputeStmt, type PersistedEvent } from './event-projection'
import { fullProgressRecomputeStmts } from './progress-projection'
import { revisionManifestKey } from './file-revision-sql'
import { ensureProjectLanes } from '../../../db/shared/lanes'
import {
  buildRevisionCellStmts,
  buildStoredManifest,
  liveUnitsIfDrifted,
  loadAdoptableUnits,
  validateUnitInputs,
  type StoredRevisionManifest,
} from './file-revision-apply'
import type { EventPayloads } from './types'
import { mergeFileMeta, type ReconcileFileMeta } from './import-reconcile-route'

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/revisions$/
const SHA256_RE = /^[0-9a-f]{64}$/
const STAMP_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}(@\d+)?$/
const ORIGINS = new Set(['import', 'reimport', 'drive', 'git', 'dcs', 'langquest'])
/** Stamp used for an adopted revision when the file never recorded one. */
export const ADOPTED_STAMP = 'aquilla:adopted@1'

export interface RevisionsRouteEnv extends Pick<AudioEnv, 'R2_KEY_PREFIX'> {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  ProjectSync?: DurableObjectNamespace
}

interface RevisionRequestBody {
  artifactSha256: string
  stamp: string
  optionsHash: string
  origin: string
  units: RevisionUnitInput[]
  /** Re-import: the file metadata the importer built (import manifest,
   *  parserVersion, languages), merged into files.meta exactly as
   *  /import/reconcile does. */
  file?: ReconcileFileMeta
  /** Re-import: the artifact the client just stored. Its sha256 must be
   *  `artifactSha256`; the file's source pointer moves to it in the same batch
   *  as the cells. Sent together with `rawSourceFormat`. */
  artifactId?: string
  rawSourceFormat?: string
  /** A fresh import's `/import` finalize (`complete: true`) follows this
   *  request and recomputes the file counters and progress. The route skips
   *  its own copy of that full-file scan, which doubled a 10k-cell import's
   *  database time. Re-imports send no finalize and leave this unset. */
  finalizeFollows?: boolean
}

interface FileRow {
  id: string
  head_revision_n: number | null
  meta: string | null
}

interface RevisionRow {
  revision_n: number
  artifact_sha256: string
  filter_stamp: string
  options_hash: string
  manifest_r2_key: string
}

/** Deterministic, so a replayed request derives the same event id. */
export function revisionEventId(fileId: string, revisionN: number, artifactSha256: string, stamp: string): string {
  return uuidV5(`revision:${revisionN}:${artifactSha256}:${stamp}`, fileId)
}

export async function handleRevisionsRequest(
  request: Request,
  env: RevisionsRouteEnv,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = PATH_RE.exec(url.pathname)
  if (!match || request.method !== 'POST') return null
  if (!env.AQUILLA_PG) return withCors(new Response('AQUILLA_PG binding not configured', { status: 500 }), request)
  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const authHeader = request.headers.get('Authorization') ?? ''
  const auth = await verifyTokenForDoc(
    authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null,
    { projectId, fileId },
    env.SYNC_SECRET_KEY,
  )
  if (!auth.ok) return withCors(new Response(auth.reason, { status: auth.status }), request)
  if (auth.claims.role < ROLE.PROJECT_LEAD) {
    return withCors(new Response('role too low for source revision', { status: 403 }), request)
  }
  const author = auth.claims.username || `user:${auth.claims.userId}`

  const read = await readTextBodyWithLimit(request.headers, request.body, MAX_IMPORT_REQUEST_BODY_BYTES)
  if (!read.ok) {
    return withCors(Response.json({ error: read.error, maxBytes: read.maxBytes }, { status: read.status }), request)
  }
  const parsed = parseBody(read.text)
  if (!parsed.ok) return withCors(new Response(parsed.reason, { status: 400 }), request)
  const body = parsed.body

  const db = env.AQUILLA_PG
  const file = await db
    // No deleted_at filter: an import stages the file as soft-deleted until it
    // publishes, and the revision lands inside that window.
    .prepare('SELECT id, head_revision_n, meta FROM files WHERE id = ? AND project_id = ?')
    .bind(fileId, projectId)
    .first<FileRow>()
  if (!file) return withCors(new Response('file not found', { status: 404 }), request)

  const prefix = r2KeyPrefix(env)
  const serverTs = Date.now()

  let artifact: { r2_key: string; size_bytes: number } | null = null
  if (body.artifactId) {
    const row = await db
      .prepare(
        `SELECT r2_key, size_bytes, sha256 FROM artifacts
         WHERE id::text = ? AND project_id = ? AND file_id = ? AND kind = 'source'`,
      )
      .bind(body.artifactId, projectId, fileId)
      .first<{ r2_key: string; size_bytes: number; sha256: string }>()
    if (!row) return withCors(new Response('source artifact not found', { status: 409 }), request)
    if (row.sha256 !== body.artifactSha256) {
      return withCors(new Response('source artifact checksum does not match artifactSha256', { status: 409 }), request)
    }
    artifact = row
  }

  // cells.lane_id is NOT NULL and resolved by subquery, so a project with no
  // lane rows yet gets its default pair first (same guard as /import).
  const anyLane = await db.prepare('SELECT 1 AS present FROM lanes WHERE project_id = ? LIMIT 1').bind(projectId).first<{ present: number }>()
  if (!anyLane) await ensureProjectLanes(db, projectId)
  let head: StoredRevisionManifest | null = null
  let adopted = false

  if (file.head_revision_n != null) {
    const row = await db
      .prepare(
        `SELECT revision_n, artifact_sha256, filter_stamp, options_hash, manifest_r2_key
         FROM file_revisions WHERE project_id = ? AND file_id = ? AND revision_n = ?`,
      )
      .bind(projectId, fileId, file.head_revision_n)
      .first<RevisionRow>()
    if (!row) return withCors(new Response('head revision row missing', { status: 500 }), request)
    if (row.artifact_sha256 === body.artifactSha256 && row.filter_stamp === body.stamp && row.options_hash === body.optionsHash) {
      return withCors(Response.json({ noop: true, revisionN: row.revision_n }), request)
    }
    const obj = await env.SNAPSHOTS.get(row.manifest_r2_key)
    if (!obj) return withCors(new Response('head revision manifest missing from R2', { status: 500 }), request)
    head = JSON.parse(await obj.text()) as StoredRevisionManifest
    // Per-cell source writes since the head (edit, split, reconcile, agent,
    // mirror) leave the manifest behind `cells`. Re-adopt the live rows as the
    // next revision so alignment, and a later rebuild, start from what the
    // file actually holds.
    const drifted = liveUnitsIfDrifted(head, await loadAdoptableUnits(db, projectId, fileId))
    if (drifted) {
      const readopted = await writeAdoptedRevision(db, env, {
        projectId,
        fileId,
        revisionN: head.revisionN + 1,
        parentRevisionN: head.revisionN,
        stamp: head.stamp,
        optionsHash: head.optionsHash,
        artifactSha256: head.artifactSha256,
        units: drifted,
        author,
        serverTs,
        prefix,
      })
      if (!readopted.ok) return withCors(new Response(readopted.reason, { status: 500 }), request)
      head = readopted.manifest
      adopted = true
    }
  } else {
    // Adopt: a materialized file joins the chain with its ids untouched.
    const adoptable = await loadAdoptableUnits(db, projectId, fileId)
    if (adoptable) {
      const applied = await writeAdoptedRevision(db, env, {
        projectId,
        fileId,
        revisionN: 1,
        parentRevisionN: null,
        stamp: parserVersionFromMeta(file.meta) ?? ADOPTED_STAMP,
        optionsHash: hashOptions({}),
        artifactSha256: await currentArtifactSha(db, projectId, fileId, body.artifactSha256),
        units: adoptable,
        author,
        serverTs,
        prefix,
      })
      if (!applied.ok) return withCors(new Response(applied.reason, { status: 500 }), request)
      head = applied.manifest
      adopted = true
    }
  }

  const revisionN = head ? head.revisionN + 1 : 1
  let delta: RevisionDelta
  try {
    delta = alignRevision(head, body.units, { fileId, revisionN })
  } catch (err) {
    return withCors(new Response(err instanceof Error ? err.message : 'alignment failed', { status: 400 }), request)
  }
  const eventId = revisionEventId(fileId, revisionN, body.artifactSha256, body.stamp)
  const manifest = buildStoredManifest(
    {
      fileId,
      revisionN,
      parentRevisionN: head ? head.revisionN : null,
      stamp: body.stamp,
      optionsHash: body.optionsHash,
      artifactSha256: body.artifactSha256,
    },
    delta.units,
    eventId,
  )
  const cellStmts = buildRevisionCellStmts(db, {
    projectId,
    fileId,
    revisionEventId: eventId,
    author,
    serverTs: serverTs + 1,
    clientTs: serverTs,
    units: delta.units,
    deleted: delta.deleted,
  })
  // Re-import: the file's own row moves with its cells, in one batch.
  const fileStmts: AquillaStatement[] = []
  if (body.file) {
    fileStmts.push(
      db
        .prepare('UPDATE files SET meta = ?, updated_at = ? WHERE id = ? AND project_id = ?')
        .bind(JSON.stringify(mergeFileMeta(file.meta, body.file)), serverTs + 1, fileId, projectId),
    )
  }
  if (artifact && body.rawSourceFormat) {
    fileStmts.push(
      db
        .prepare(
          `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT (file_id) DO UPDATE SET
             project_id = EXCLUDED.project_id, format = EXCLUDED.format, raw_source = NULL,
             r2_key = EXCLUDED.r2_key, size_bytes = EXCLUDED.size_bytes, created_at = EXCLUDED.created_at
           WHERE file_source_blobs.project_id = EXCLUDED.project_id`,
        )
        .bind(fileId, projectId, body.rawSourceFormat, artifact.r2_key, Number(artifact.size_bytes), serverTs + 1),
    )
  }
  const applied = await writeRevision(db, env, {
    projectId,
    fileId,
    manifest,
    eventId,
    author,
    serverTs: serverTs + 1,
    origin: body.origin,
    counts: delta.counts,
    cellStmts: [...cellStmts, ...fileStmts],
    prefix,
    skipRecompute: body.finalizeFollows === true,
  })
  if (!applied.ok) return withCors(new Response(applied.reason, { status: 500 }), request)

  if (env.ProjectSync) {
    const notify = notifyProjectDoFileProgressChanged(env, projectId, fileId, false).catch((err) => {
      console.warn(`[revisions] ProjectSync notify failed for ${projectId}/${fileId}:`, err)
    })
    if (ctx) ctx.waitUntil(notify)
    else void notify
  }

  return withCors(
    Response.json({ noop: false, revisionN, eventId, adopted, counts: delta.counts, unitCount: delta.units.length }),
    request,
  )
}

/**
 * Record the file's CURRENT source rows as a revision, ids and event ids
 * untouched, without writing `cells`: a legacy file's first revision, or a
 * re-adoption after per-cell writes moved `cells` past the head.
 */
async function writeAdoptedRevision(
  db: AquillaDb,
  env: RevisionsRouteEnv,
  args: {
    projectId: string
    fileId: string
    revisionN: number
    parentRevisionN: number | null
    stamp: string
    optionsHash: string
    artifactSha256: string
    units: StoredRevisionManifest['units']
    author: string
    serverTs: number
    prefix: string
  },
): Promise<{ ok: true; manifest: StoredRevisionManifest } | { ok: false; reason: string }> {
  const manifest: StoredRevisionManifest = {
    fileId: args.fileId,
    revisionN: args.revisionN,
    parentRevisionN: args.parentRevisionN,
    stamp: args.stamp,
    optionsHash: args.optionsHash,
    artifactSha256: args.artifactSha256,
    adopted: true,
    units: args.units,
  }
  const applied = await writeRevision(db, env, {
    projectId: args.projectId,
    fileId: args.fileId,
    manifest,
    eventId: revisionEventId(args.fileId, args.revisionN, args.artifactSha256, args.stamp),
    author: args.author,
    serverTs: args.serverTs,
    origin: 'adopt',
    counts: { equal: 0, changed: 0, moved: 0, inserted: args.units.length, deleted: 0 },
    cellStmts: [],
    prefix: args.prefix,
  })
  return applied.ok ? { ok: true, manifest } : applied
}

interface WriteArgs {
  projectId: string
  fileId: string
  manifest: StoredRevisionManifest
  eventId: string
  author: string
  serverTs: number
  origin: string
  counts: EventPayloads['file.revision']['counts']
  cellStmts: AquillaStatement[]
  prefix: string
  /** See RevisionRequestBody.finalizeFollows. */
  skipRecompute?: boolean
}

/**
 * Manifest to R2 first, then one batch: the event row, the index row + head,
 * the cells, the counters. A failed batch removes the manifest object so a
 * retry starts clean.
 */
async function writeRevision(
  db: AquillaDb,
  env: RevisionsRouteEnv,
  args: WriteArgs,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const manifestKey = revisionManifestKey(args.prefix, args.projectId, args.fileId, args.manifest.revisionN)
  await env.SNAPSHOTS.put(manifestKey, JSON.stringify(args.manifest), {
    httpMetadata: { contentType: 'application/json' },
  })
  const payload: EventPayloads['file.revision'] = {
    revisionN: args.manifest.revisionN,
    parentRevisionN: args.manifest.parentRevisionN,
    artifactSha256: args.manifest.artifactSha256,
    stamp: args.manifest.stamp,
    optionsHash: args.manifest.optionsHash,
    manifestR2Key: manifestKey,
    unitCount: args.manifest.units.length,
    counts: args.counts,
    origin: args.origin,
  }
  const event: PersistedEvent<'file.revision'> = {
    id: args.eventId,
    schemaVersion: 1,
    projectId: args.projectId,
    fileId: args.fileId,
    cellId: null,
    parentId: null,
    kind: 'file.revision',
    author: args.author,
    payload,
    clientTs: args.serverTs,
    serverTs: args.serverTs,
  }
  try {
    const seq = await allocateSeqRange(db, args.projectId, 1)
    const stmts: AquillaStatement[] = [
      buildBulkEventInsertStmt(db, [
        {
          id: event.id,
          schemaVersion: 1,
          projectId: args.projectId,
          fileId: args.fileId,
          cellId: null,
          parentId: null,
          kind: 'file.revision',
          author: args.author,
          payloadJson: JSON.stringify(payload),
          clientTs: args.serverTs,
          serverTs: args.serverTs,
          serverSeq: seq,
        },
      ]),
      buildSettleSeqRangeStmt(db, args.projectId, seq),
    ]
    buildEventProjectionStmts(db, event, stmts)
    stmts.push(...args.cellStmts)
    if (args.cellStmts.length > 0 && !args.skipRecompute) {
      stmts.push(fileCountersRecomputeStmt(db, args.projectId, args.fileId, args.serverTs))
      stmts.push(...fullProgressRecomputeStmts(db, args.projectId, args.fileId, args.serverTs))
    }
    const longDb = withLongOperationTimeout(db, 'import-finalize')
    if (longDb.batchPipelined) await longDb.batchPipelined(stmts)
    else await longDb.batch(stmts)
    return { ok: true }
  } catch (err) {
    await env.SNAPSHOTS.delete(manifestKey).catch(() => undefined)
    console.error(`[revisions] write failed for ${args.projectId}/${args.fileId} r${args.manifest.revisionN}:`, err)
    return { ok: false, reason: 'revision write failed' }
  }
}

function parseBody(text: string): { ok: true; body: RevisionRequestBody } | { ok: false; reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'body must be JSON' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'body must be an object' }
  const r = raw as Record<string, unknown>
  if (typeof r.artifactSha256 !== 'string' || !SHA256_RE.test(r.artifactSha256)) {
    return { ok: false, reason: 'artifactSha256 must be 64 lower-case hex characters' }
  }
  if (typeof r.stamp !== 'string' || !STAMP_RE.test(r.stamp)) return { ok: false, reason: 'stamp must look like <filterId>@<walk>' }
  const origin = r.origin === undefined ? 'import' : r.origin
  if (typeof origin !== 'string' || !ORIGINS.has(origin)) return { ok: false, reason: 'origin is not a known revision origin' }
  const optionsHash = r.optionsHash === undefined ? hashOptions({}) : r.optionsHash
  if (typeof optionsHash !== 'string' || !optionsHash) return { ok: false, reason: 'optionsHash must be a string' }
  const units = validateUnitInputs(r.units)
  if (!units.ok) return units
  if (r.file !== undefined) {
    const f = r.file as Record<string, unknown> | null
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.id !== 'string' || !f.id || typeof f.name !== 'string' || !f.name) {
      return { ok: false, reason: 'file must be an object with an id and a name' }
    }
    if (f.importManifest !== undefined && (!f.importManifest || typeof f.importManifest !== 'object' || Array.isArray(f.importManifest))) {
      return { ok: false, reason: 'file.importManifest must be an object' }
    }
  }
  if (r.artifactId !== undefined && (typeof r.artifactId !== 'string' || !r.artifactId)) return { ok: false, reason: 'artifactId must be a string' }
  if (r.rawSourceFormat !== undefined && (typeof r.rawSourceFormat !== 'string' || !r.rawSourceFormat)) {
    return { ok: false, reason: 'rawSourceFormat must be a string' }
  }
  if (r.finalizeFollows !== undefined && typeof r.finalizeFollows !== 'boolean') {
    return { ok: false, reason: 'finalizeFollows must be a boolean' }
  }
  if ((r.artifactId === undefined) !== (r.rawSourceFormat === undefined)) {
    return { ok: false, reason: 'artifactId and rawSourceFormat must be provided together' }
  }
  return {
    ok: true,
    body: {
      artifactSha256: r.artifactSha256,
      stamp: r.stamp,
      optionsHash,
      origin,
      units: units.units,
      ...(r.file !== undefined ? { file: r.file as ReconcileFileMeta } : {}),
      ...(typeof r.artifactId === 'string' ? { artifactId: r.artifactId } : {}),
      ...(typeof r.rawSourceFormat === 'string' ? { rawSourceFormat: r.rawSourceFormat } : {}),
      ...(r.finalizeFollows === true ? { finalizeFollows: true } : {}),
    },
  }
}

function parserVersionFromMeta(meta: string | null): string | null {
  if (!meta) return null
  try {
    const parsed = JSON.parse(meta) as { parserVersion?: unknown }
    return typeof parsed.parserVersion === 'string' && parsed.parserVersion ? parsed.parserVersion : null
  } catch {
    return null
  }
}

/**
 * The sha256 of the original a legacy file holds NOW, for its adopted
 * revision 1. The source pointer (file_source_blobs) names it; without one,
 * the newest source artifact that is not the incoming re-import (the client
 * stores the new bytes before it posts the revision).
 */
async function currentArtifactSha(db: AquillaDb, projectId: string, fileId: string, incomingSha: string): Promise<string> {
  const pointed = await db
    .prepare(
      `SELECT a.sha256 FROM file_source_blobs b
       JOIN artifacts a ON a.project_id = b.project_id AND a.r2_key = b.r2_key AND a.kind = 'source'
       WHERE b.file_id = ? AND b.project_id = ?
       ORDER BY a.created_at DESC LIMIT 1`,
    )
    .bind(fileId, projectId)
    .first<{ sha256: string | null }>()
  if (pointed?.sha256) return pointed.sha256
  const row = await db
    .prepare(
      `SELECT sha256 FROM artifacts WHERE project_id = ? AND file_id = ? AND kind = 'source' AND sha256 <> ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(projectId, fileId, incomingSha)
    .first<{ sha256: string | null }>()
  return row?.sha256 ?? ''
}
