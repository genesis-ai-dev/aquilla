// AQU-2345: a file brought into a project by a source link keeps its export.
//
// `file_source_blobs` is where every round-trip export resolves the original
// upload from (sync-worker `events/export-route.ts`, `events/original-download-route.ts`),
// and `files-read-route.ts` reads `hasOriginalSource` off nothing but the
// existence of that row. Both linking paths — the live mirror
// (sync-worker `events/link-sync.ts`) and the clone/detach snapshot
// (auth-worker `services/source-linking.ts`) — carried the upstream's cells
// and `files` row into the downstream project and left that side-car behind.
// So an IDML file linked from a source project into a language project read
// `hasOriginalSource: false` and 404'd on export with "no source blob recorded
// for this file — re-import to enable export": every EBL language project and
// every BSB batch past the one imported directly from IDML. A 100%-validated
// Portuguese Facilitator Guide could not be delivered, and re-importing to fix
// it would have wiped the translations.
//
// The fix is a POINTER, not a copy: the downstream row carries the upstream
// row's `format`, `r2_key` and `size_bytes`, so export resolves the very same
// R2 object the upstream's own export does. Both projects live in one
// `aquilla-snapshots` bucket, the export route already serves an
// `r2_key`-only row for every format, and no bytes move. This is the same
// move AQU-1120 made for the Agent API's import path (sync-worker
// `external/commit.ts`), which 404'd on export for the same reason.
//
// Bytes are only ever read, never written: the sweep inserts missing
// `file_source_blobs` rows and nothing else. It touches no `cells`, no
// `events`, no validation state, and `ON CONFLICT (file_id) DO NOTHING` means
// a file that recorded an original of its own keeps it. Running it twice is a
// no-op, which is what lets it double as the backfill for projects whose link
// already ran.
//
// Shared by both workers, which pass their own `downstreamFileIdOf` — the two
// packages keep separate copies of `deterministicDownstreamFileId` (see its
// doc comment in auth-worker `services/source-linking.ts`), so the sweep takes
// the derivation rather than picking one of them.

import type { AquillaDb } from "../shim/postgres"

/** One upstream side-car row, as the sweep reads it. */
interface UpstreamBlobRow {
  file_id: string
  format: string
  raw_source: string | null
  r2_key: string | null
  size_bytes: number | string | null
}

export interface LinkSourceBlobArgs {
  /** The project the link reads from — where the originals live. */
  upstreamProjectId: string
  /** The project the link writes into — where the rows are missing. */
  downstreamProjectId: string
  /**
   * The downstream `files.id` that mirrors a given upstream file id. The live
   * mirror and the snapshot each derive it their own way (and a snapshot copy
   * may hold a random UUID instead), which is why the sweep also matches on
   * `files.meta.upstreamFileId` below — the AQU-1547 provenance stamp both
   * paths write.
   */
  downstreamFileIdOf: (upstreamFileId: string) => string
  /** Injectable clock for tests. */
  now?: () => number
}

/** `files.meta.upstreamFileId` (AQU-1547), or null. `meta` is a TEXT column,
 *  so a malformed or non-object legacy blob degrades to "no stamp" rather than
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

/**
 * Point every linked downstream file with no side-car row at its upstream
 * file's original artifact. Returns how many rows were written.
 *
 * Cheap to call on every sync: in the steady state the first query comes back
 * empty (every file has a row) and nothing else runs. Call it BEFORE a sync
 * can decide it has nothing to do — that is the path a project whose link
 * already ran takes, and the one that backfills it — and again after new files
 * have been mirrored in, so a first sync does not leave its own files waiting
 * for the next one.
 */
export async function linkSourceBlobPointers(
  db: AquillaDb,
  args: LinkSourceBlobArgs,
): Promise<number> {
  const { upstreamProjectId, downstreamProjectId, downstreamFileIdOf } = args
  if (!upstreamProjectId || !downstreamProjectId) return 0
  if (upstreamProjectId === downstreamProjectId) return 0

  // Live downstream files with no side-car of their own. A soft-deleted file
  // needs no export; a later restore is followed by another sweep.
  const missing = await db
    .prepare(
      `SELECT f.id AS id, f.meta AS meta
         FROM files f
         LEFT JOIN file_source_blobs b ON b.file_id = f.id
        WHERE f.project_id = ? AND f.deleted_at IS NULL AND b.file_id IS NULL`,
    )
    .bind(downstreamProjectId)
    .all<{ id: string; meta: string | null }>()
  if (missing.results.length === 0) return 0

  const upstream = await db
    .prepare(
      `SELECT file_id, format, raw_source, r2_key, size_bytes
         FROM file_source_blobs WHERE project_id = ?`,
    )
    .bind(upstreamProjectId)
    .all<UpstreamBlobRow>()
  if (upstream.results.length === 0) return 0

  const byUpstreamFileId = new Map<string, UpstreamBlobRow>()
  const byMirroredFileId = new Map<string, UpstreamBlobRow>()
  for (const row of upstream.results) {
    byUpstreamFileId.set(row.file_id, row)
    byMirroredFileId.set(downstreamFileIdOf(row.file_id), row)
  }

  const createdAt = (args.now ?? Date.now)()
  let written = 0
  for (const file of missing.results) {
    const stamped = stampedUpstreamFileId(file.meta)
    // Provenance stamp first, the derived mirror id second: the stamp names the
    // upstream file even after it is renamed or the copy was given a random id,
    // and the derived id covers rows mirrored before the stamp existed.
    const blob = (stamped ? byUpstreamFileId.get(stamped) : undefined) ?? byMirroredFileId.get(file.id)
    if (!blob) continue
    // Prefer the R2 pointer, which copies nothing. `raw_source` is the legacy
    // inline-base64 path and only carried when there is no object to point at,
    // because an export resolving neither is the 404 this fixes.
    if (!blob.r2_key && !blob.raw_source) continue
    await db
      .prepare(
        `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (file_id) DO NOTHING`,
      )
      .bind(
        file.id,
        downstreamProjectId,
        blob.format,
        blob.r2_key ? null : blob.raw_source,
        blob.r2_key,
        blob.size_bytes === null || blob.size_bytes === undefined ? null : Number(blob.size_bytes),
        createdAt,
      )
      .run()
    written++
  }
  return written
}
