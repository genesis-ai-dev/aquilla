// AQU-2345: the provenance a file linked from a source project carries.
//
// A file brought into a project by a source link — the live mirror's
// `file.mirror` (sync-worker events/link-sync.ts) or the clone/detach snapshot
// (auth-worker services/source-linking.ts) — is the upstream file's material
// under a new id. Two things about it used to be lost on the way:
//
//   1. its TYPE: `file.mirror` projected `role`, `kind` and `book_code` as
//      NULL, so every mirrored file read as `fileType: codex` (the read side
//      derives `kind ?? role ?? 'codex'`) whatever it was imported as, and the
//      export dialog never offered the IDML/DOCX/PPTX round-trip for it;
//   2. its ORIGINAL: nothing wrote a `file_source_blobs` row for the new file,
//      so `GET /files/:id/source` answered "no source blob recorded for this
//      file" — the upload the upstream kept was unreachable from the copy.
//
// Both are repaired here, by the same two rules, for both workers:
//
//   - the type is copied where the copy's column is NULL — never overwritten,
//     so a file that already knows what it is keeps that;
//   - the original is a POINTER: a `file_source_blobs` row for the copy that
//     names the upstream's R2 object (`r2_key`) — one row, no byte copy — and
//     follows the upstream's row when that changes (a re-import upstream). A
//     legacy inline original (`raw_source`, pre-R2) is copied as text; there
//     is no object to point at. The R2 sweep (sync-worker r2-gc.ts) keeps an
//     uploaded original while its `artifacts` row exists, and nothing deletes
//     those rows, so a pointer never outlives its object.
//
// An adopted file — an upstream file the link follows INTO one of the project's
// own files (`projects.source_link_adopt`, AQU-1679) — is the project's own
// import, so the type rule has nothing to do for it (the fill only ever touches
// NULL columns). Its ORIGINAL is another matter: the join writes the upstream's
// source onto its cells, locators included, so from then on the cells describe
// the upstream's package, not the one the file was imported from. An IDML export
// read against its own original then rejected every mapping ("IDML export
// rejected N invalid translation mapping(s)"). So once the join has run, an
// adopted file gets the pointer rule like any copy; while it is still pending
// its cells are its own and it is left alone.

import type { AquillaDb, AquillaStatement } from "../shim/postgres"
import type { SourceLinkAdoption } from "./source-link-adopt"

export interface LinkedFilePair {
  upstreamFileId: string
  downstreamFileId: string
}

/** The columns of `files` the type rule reads. */
export interface ProvenanceFileRow {
  id: string
  role: string | null
  kind: string | null
  book_code: string | null
}

/** The columns of `file_source_blobs` the pointer rule compares. */
export interface ProvenanceBlobRow {
  file_id: string
  format: string
  r2_key: string | null
  size_bytes: number | string | null
}

export interface LinkedFileTypeRepair extends LinkedFilePair {
  /** The upstream's values. Each lands only where the copy's column is NULL. */
  role: string | null
  kind: string | null
  bookCode: string | null
}

export interface LinkedFileProvenancePlan {
  /** Copies with a NULL `kind`, `role` or `book_code` where the upstream's is set. */
  typeRepairs: LinkedFileTypeRepair[]
  /** Copies whose pointer row is missing or no longer matches the upstream's. */
  blobPointers: LinkedFilePair[]
  /** Pairs whose upstream file has no original of its own — nothing to point at. */
  noUpstreamBlob: LinkedFilePair[]
}

export interface LinkedFileProvenanceInputs {
  pairs: readonly LinkedFilePair[]
  upstreamFiles: ReadonlyMap<string, ProvenanceFileRow>
  downstreamFiles: ReadonlyMap<string, ProvenanceFileRow>
  upstreamBlobs: ReadonlyMap<string, ProvenanceBlobRow>
  downstreamBlobs: ReadonlyMap<string, ProvenanceBlobRow>
}

function blobSize(row: ProvenanceBlobRow): number | null {
  return row.size_bytes == null ? null : Number(row.size_bytes)
}

/** Same object (or same inline text, by size): the pointer is current. */
function sameBlob(a: ProvenanceBlobRow, b: ProvenanceBlobRow): boolean {
  return a.format === b.format && (a.r2_key ?? null) === (b.r2_key ?? null) && blobSize(a) === blobSize(b)
}

/** Pure: which pairs need which write. */
export function planLinkedFileProvenance(inputs: LinkedFileProvenanceInputs): LinkedFileProvenancePlan {
  const plan: LinkedFileProvenancePlan = { typeRepairs: [], blobPointers: [], noUpstreamBlob: [] }
  for (const pair of inputs.pairs) {
    const upstream = inputs.upstreamFiles.get(pair.upstreamFileId)
    const downstream = inputs.downstreamFiles.get(pair.downstreamFileId)
    // A copy whose row is not there yet (the same batch is creating it) takes
    // its type from the event that creates it; nothing to repair.
    if (upstream && downstream) {
      const fills =
        (downstream.role == null && upstream.role != null) ||
        (downstream.kind == null && upstream.kind != null) ||
        (downstream.book_code == null && upstream.book_code != null)
      if (fills) {
        plan.typeRepairs.push({ ...pair, role: upstream.role, kind: upstream.kind, bookCode: upstream.book_code })
      }
    }
    const upstreamBlob = inputs.upstreamBlobs.get(pair.upstreamFileId)
    if (!upstreamBlob) {
      plan.noUpstreamBlob.push(pair)
      continue
    }
    const downstreamBlob = inputs.downstreamBlobs.get(pair.downstreamFileId)
    if (!downstreamBlob || !sameBlob(upstreamBlob, downstreamBlob)) plan.blobPointers.push(pair)
  }
  return plan
}

/** `IN (?, ?, …)` — the codebase's id-list convention (never `= ANY(?)`),
 *  paged so one statement never binds more than the driver carries. */
const ID_PAGE = 500

async function selectByIds<T>(
  db: AquillaDb,
  ids: readonly string[],
  sqlFor: (placeholders: string) => string,
  projectId: string,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += ID_PAGE) {
    const page = ids.slice(i, i + ID_PAGE)
    const placeholders = page.map(() => "?").join(", ")
    const rows = await db.prepare(sqlFor(placeholders)).bind(projectId, ...page).all<T>()
    out.push(...(rows.results ?? []))
  }
  return out
}

export async function loadLinkedFileProvenanceInputs(
  db: AquillaDb,
  args: { upstreamProjectId: string; downstreamProjectId: string; pairs: readonly LinkedFilePair[] },
): Promise<LinkedFileProvenanceInputs> {
  const upstreamIds = [...new Set(args.pairs.map((p) => p.upstreamFileId))]
  const downstreamIds = [...new Set(args.pairs.map((p) => p.downstreamFileId))]
  const filesSql = (placeholders: string) =>
    `SELECT id, role, kind, book_code FROM files WHERE project_id = ? AND id IN (${placeholders})`
  const blobsSql = (placeholders: string) =>
    `SELECT file_id, format, r2_key, size_bytes FROM file_source_blobs WHERE project_id = ? AND file_id IN (${placeholders})`
  const [upstreamFiles, downstreamFiles, upstreamBlobs, downstreamBlobs] = await Promise.all([
    selectByIds<ProvenanceFileRow>(db, upstreamIds, filesSql, args.upstreamProjectId),
    selectByIds<ProvenanceFileRow>(db, downstreamIds, filesSql, args.downstreamProjectId),
    selectByIds<ProvenanceBlobRow>(db, upstreamIds, blobsSql, args.upstreamProjectId),
    selectByIds<ProvenanceBlobRow>(db, downstreamIds, blobsSql, args.downstreamProjectId),
  ])
  return {
    pairs: args.pairs,
    upstreamFiles: new Map(upstreamFiles.map((r) => [r.id, r])),
    downstreamFiles: new Map(downstreamFiles.map((r) => [r.id, r])),
    upstreamBlobs: new Map(upstreamBlobs.map((r) => [r.file_id, r])),
    downstreamBlobs: new Map(downstreamBlobs.map((r) => [r.file_id, r])),
  }
}

/** Fill the copy's NULL type columns from the upstream's. COALESCE keeps a
 *  value the copy already has, so this never overwrites. */
export function linkedFileTypeRepairStmt(
  db: AquillaDb,
  args: { projectId: string; fileId: string; role: string | null; kind: string | null; bookCode: string | null; now: number },
): AquillaStatement {
  return db
    .prepare(
      `UPDATE files
          SET role = COALESCE(role, ?),
              kind = COALESCE(kind, ?),
              book_code = COALESCE(book_code, ?),
              updated_at = ?
        WHERE id = ? AND project_id = ?`,
    )
    .bind(args.role, args.kind, args.bookCode, args.now, args.fileId, args.projectId)
}

/** The copy's original: the upstream row's object (or inline text), under the
 *  copy's file id. Inserts a missing row and refreshes one that exists, so a
 *  copy follows the upstream's current original. Reads the upstream row at
 *  execution time, so a row that has disappeared inserts nothing. */
export function linkedFileSourceBlobStmt(
  db: AquillaDb,
  args: {
    downstreamFileId: string
    downstreamProjectId: string
    upstreamFileId: string
    upstreamProjectId: string
    now: number
  },
): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       SELECT ?, ?, format, raw_source, r2_key, size_bytes, ?
         FROM file_source_blobs
        WHERE file_id = ? AND project_id = ?
       ON CONFLICT (file_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         format     = EXCLUDED.format,
         raw_source = EXCLUDED.raw_source,
         r2_key     = EXCLUDED.r2_key,
         size_bytes = EXCLUDED.size_bytes,
         created_at = EXCLUDED.created_at`,
    )
    .bind(args.downstreamFileId, args.downstreamProjectId, args.now, args.upstreamFileId, args.upstreamProjectId)
}

export function linkedFileProvenanceStmts(
  db: AquillaDb,
  plan: LinkedFileProvenancePlan,
  args: { upstreamProjectId: string; downstreamProjectId: string; now: number },
): AquillaStatement[] {
  const stmts: AquillaStatement[] = []
  for (const repair of plan.typeRepairs) {
    stmts.push(
      linkedFileTypeRepairStmt(db, {
        projectId: args.downstreamProjectId,
        fileId: repair.downstreamFileId,
        role: repair.role,
        kind: repair.kind,
        bookCode: repair.bookCode,
        now: args.now,
      }),
    )
  }
  for (const pair of plan.blobPointers) {
    stmts.push(
      linkedFileSourceBlobStmt(db, {
        downstreamFileId: pair.downstreamFileId,
        downstreamProjectId: args.downstreamProjectId,
        upstreamFileId: pair.upstreamFileId,
        upstreamProjectId: args.upstreamProjectId,
        now: args.now,
      }),
    )
  }
  return stmts
}

export interface LinkedFileProvenanceArgs {
  upstreamProjectId: string
  downstreamProjectId: string
  /** Mirrored copies, and adopted files whose join has run (see the header). */
  pairs: readonly LinkedFilePair[]
  now: number
}

/** Read, plan and build — for a caller that runs the statements in a batch of
 *  its own (the mirror window). */
export async function planLinkedFileProvenanceFor(
  db: AquillaDb,
  args: LinkedFileProvenanceArgs,
): Promise<{ plan: LinkedFileProvenancePlan; stmts: AquillaStatement[] }> {
  if (args.pairs.length === 0) {
    return { plan: { typeRepairs: [], blobPointers: [], noUpstreamBlob: [] }, stmts: [] }
  }
  const inputs = await loadLinkedFileProvenanceInputs(db, args)
  const plan = planLinkedFileProvenance(inputs)
  return { plan, stmts: linkedFileProvenanceStmts(db, plan, args) }
}

/** Read, plan and write. `dryRun` returns the plan and writes nothing. */
export async function applyLinkedFileProvenance(
  db: AquillaDb,
  args: LinkedFileProvenanceArgs & { dryRun?: boolean },
): Promise<LinkedFileProvenancePlan> {
  const { plan, stmts } = await planLinkedFileProvenanceFor(db, args)
  if (!args.dryRun && stmts.length > 0) await db.batch(stmts)
  return plan
}

// ── The whole-project sweep (AQU-2438) ────────────────────────────────────────
//
// The rules above ride each mirror window, applied to the files that window
// touched (sync-worker link-sync.ts `provenancePairs`). That repairs a copy the
// next time its upstream file has something to say — and never repairs one
// whose upstream is finished. Every EBL language project and every linked BSB
// batch is exactly that: the upstream is stable, so the fold had nothing to
// mirror, so the copies kept `kind: NULL` and read as `fileType: codex`, and
// the IDML download stayed hidden behind "Repair" (which re-parses the file
// into an `idml`-typed sibling and drops the validation — AQU-2380 Finding 6).
//
// So the sweep below takes the WHOLE downstream project, pairing every live
// copy with its upstream file, and runs on every link sync before the fold can
// decide it has nothing to do. Four project-scoped reads, no id lists, and in
// the repaired steady state the plan is empty and nothing is written: the same
// shape the `file_source_blobs` sweep it replaces had (db/shared/link-source-
// blob.ts, still auth-worker's), now carrying the type rule too. It is also
// what `POST /admin/link-provenance` runs, so the backfill and the per-sync
// repair cannot drift apart.

/** `files.meta.upstreamFileId` (AQU-1547), or null. `meta` is a TEXT column, so
 *  a malformed or non-object legacy blob degrades to "no stamp" rather than
 *  throwing and failing the sweep over one bad row. */
function stampedUpstreamFileId(meta: string | null): string | null {
  if (!meta) return null
  try {
    const parsed = JSON.parse(meta) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>).upstreamFileId
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

export interface ProjectLinkedFileProvenanceArgs {
  upstreamProjectId: string
  downstreamProjectId: string
  /** The downstream id a live mirror gives an upstream file's copy. Pairs rows
   *  mirrored before the `meta.upstreamFileId` stamp existed (AQU-1547). The
   *  two workers keep separate copies of the derivation, so the sweep takes it
   *  rather than picking one. */
  downstreamFileIdOf: (upstreamFileId: string) => string
  /** The link's adopted files (`projects.source_link_adopt`, AQU-1679). A file
   *  whose join has run is paired with the upstream file it now follows, so its
   *  original is the package its cells describe; one still pending is the
   *  project's own and is never paired by derivation either. */
  adoption?: SourceLinkAdoption | null
  now: number
  /** Plan only; write nothing. */
  dryRun?: boolean
}

export interface ProjectLinkedFileProvenanceResult {
  plan: LinkedFileProvenancePlan
  /** Live copies paired with an upstream file. */
  pairs: LinkedFilePair[]
  /** Live files that are the project's own — adopted, or its own import. */
  ownFileIds: string[]
}

const EMPTY_PROJECT_RESULT: ProjectLinkedFileProvenanceResult = {
  plan: { typeRepairs: [], blobPointers: [], noUpstreamBlob: [] },
  pairs: [],
  ownFileIds: [],
}

/** Pair every live downstream file with its upstream file, then plan (and,
 *  unless `dryRun`, write) both rules for the pairs. */
export async function applyProjectLinkedFileProvenance(
  db: AquillaDb,
  args: ProjectLinkedFileProvenanceArgs,
): Promise<ProjectLinkedFileProvenanceResult> {
  const { upstreamProjectId, downstreamProjectId } = args
  if (!upstreamProjectId || !downstreamProjectId) return EMPTY_PROJECT_RESULT
  if (upstreamProjectId === downstreamProjectId) return EMPTY_PROJECT_RESULT

  const filesSql = (withMeta: boolean) =>
    `SELECT id, role, kind, book_code${withMeta ? ", meta" : ""} FROM files WHERE project_id = ?`
  const blobsSql = `SELECT file_id, format, r2_key, size_bytes FROM file_source_blobs WHERE project_id = ?`
  const [upstreamRows, downstreamRows, upstreamBlobRows, downstreamBlobRows] = await Promise.all([
    // Every upstream file, Recently deleted included: a copy of a file the
    // upstream has since set aside is still that file's material, and the
    // upstream's original row outlives the tombstone.
    db.prepare(filesSql(false)).bind(upstreamProjectId).all<ProvenanceFileRow>(),
    db
      .prepare(`${filesSql(true)} AND deleted_at IS NULL`)
      .bind(downstreamProjectId)
      .all<ProvenanceFileRow & { meta: string | null }>(),
    db.prepare(blobsSql).bind(upstreamProjectId).all<ProvenanceBlobRow>(),
    db.prepare(blobsSql).bind(downstreamProjectId).all<ProvenanceBlobRow>(),
  ])

  const upstreamFiles = new Map((upstreamRows.results ?? []).map((r) => [r.id, r]))
  if (upstreamFiles.size === 0) return EMPTY_PROJECT_RESULT
  const upstreamOfMirroredId = new Map<string, string>()
  for (const id of upstreamFiles.keys()) upstreamOfMirroredId.set(args.downstreamFileIdOf(id), id)

  const adoptedFiles = args.adoption?.files ?? {}
  const pending = new Set(args.adoption?.pending ?? [])
  const upstreamOfAdoptedId = new Map<string, string>()
  for (const [upstreamFileId, downstreamFileId] of Object.entries(adoptedFiles)) {
    upstreamOfAdoptedId.set(downstreamFileId, upstreamFileId)
  }

  const downstreamFiles = new Map<string, ProvenanceFileRow>()
  const pairs: LinkedFilePair[] = []
  const ownFileIds: string[] = []
  const joinedAdoptedIds = new Set<string>()
  for (const row of downstreamRows.results ?? []) {
    downstreamFiles.set(row.id, row)
    const adoptedUpstream = upstreamOfAdoptedId.get(row.id)
    if (adoptedUpstream !== undefined) {
      // Joined: its cells now describe the upstream's package. Pending, or an
      // upstream file that has since gone: the project's own, left alone.
      if (!pending.has(adoptedUpstream) && upstreamFiles.has(adoptedUpstream)) {
        pairs.push({ upstreamFileId: adoptedUpstream, downstreamFileId: row.id })
        joinedAdoptedIds.add(row.id)
      } else {
        ownFileIds.push(row.id)
      }
      continue
    }
    // The provenance stamp first, the derived mirror id second: the stamp names
    // the upstream file even after a rename or a random-id snapshot copy, and
    // the derived id covers rows mirrored before the stamp existed. A file
    // matching neither is the project's own import.
    const stamped = stampedUpstreamFileId(row.meta)
    const upstreamFileId =
      stamped != null && upstreamFiles.has(stamped) ? stamped : upstreamOfMirroredId.get(row.id)
    if (!upstreamFileId) {
      ownFileIds.push(row.id)
      continue
    }
    pairs.push({ upstreamFileId, downstreamFileId: row.id })
  }
  if (pairs.length === 0) return { ...EMPTY_PROJECT_RESULT, ownFileIds }

  const planned = planLinkedFileProvenance({
    pairs,
    upstreamFiles,
    downstreamFiles,
    upstreamBlobs: new Map((upstreamBlobRows.results ?? []).map((r) => [r.file_id, r])),
    downstreamBlobs: new Map((downstreamBlobRows.results ?? []).map((r) => [r.file_id, r])),
  })
  // An adopted file's type is its own import's; only its original follows.
  const plan: LinkedFileProvenancePlan = {
    ...planned,
    typeRepairs: planned.typeRepairs.filter((repair) => !joinedAdoptedIds.has(repair.downstreamFileId)),
  }
  const stmts = linkedFileProvenanceStmts(db, plan, {
    upstreamProjectId,
    downstreamProjectId,
    now: args.now,
  })
  if (!args.dryRun && stmts.length > 0) await db.batch(stmts)
  return { plan, pairs, ownFileIds }
}
