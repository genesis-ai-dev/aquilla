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
  loadAdoptableUnits,
  validateUnitInputs,
  type StoredRevisionManifest,
} from './file-revision-apply'
import type { EventPayloads } from './types'

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
  } else {
    // Adopt: a materialized file joins the chain with its ids untouched.
    const adoptable = await loadAdoptableUnits(db, projectId, fileId)
    if (adoptable) {
      const stamp = parserVersionFromMeta(file.meta) ?? ADOPTED_STAMP
      const artifactSha = await latestArtifactSha(db, projectId, fileId)
      const eventId = revisionEventId(fileId, 1, artifactSha, stamp)
      const manifest: StoredRevisionManifest = {
        fileId,
        revisionN: 1,
        parentRevisionN: null,
        stamp,
        optionsHash: hashOptions({}),
        artifactSha256: artifactSha,
        adopted: true,
        units: adoptable,
      }
      const applied = await writeRevision(db, env, {
        projectId,
        fileId,
        manifest,
        eventId,
        author,
        serverTs,
        origin: 'adopt',
        counts: { equal: 0, changed: 0, moved: 0, inserted: adoptable.length, deleted: 0 },
        cellStmts: [],
        prefix,
      })
      if (!applied.ok) return withCors(new Response(applied.reason, { status: 500 }), request)
      head = manifest
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
  const applied = await writeRevision(db, env, {
    projectId,
    fileId,
    manifest,
    eventId,
    author,
    serverTs: serverTs + 1,
    origin: body.origin,
    counts: delta.counts,
    cellStmts,
    prefix,
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
    if (args.cellStmts.length > 0) {
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
  return { ok: true, body: { artifactSha256: r.artifactSha256, stamp: r.stamp, optionsHash, origin, units: units.units } }
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

async function latestArtifactSha(db: AquillaDb, projectId: string, fileId: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT sha256 FROM artifacts WHERE project_id = ? AND file_id = ? AND kind = 'source'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(projectId, fileId)
    .first<{ sha256: string | null }>()
  return row?.sha256 ?? ''
}
