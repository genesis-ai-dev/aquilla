// AQU-1833 — projection snapshots in R2, tagged with the `server_seq` they
// reflect, so a rebuild starts from the latest snapshot instead of the first
// event ever written.
//
// Snapshots were dropped in an earlier migration, which left recovery meaning
// "replay the whole log": rebuild time grows without limit as a project ages,
// and the only tool for a bad projection is the most expensive one.
//
// ── What a snapshot is ────────────────────────────────────────────────────
//
// The two projection tables a rebuild REPLAYS — `cells` and `cell_validators`
// — captured as JSON, plus the `server_seq` they reflect. Nothing else is in
// here on purpose:
//
//   • `files` counters and `file_section_progress` are RECOMPUTED set-based at
//     the end of every rebuild (rebuild.ts steps 4b and 5), from `cells`. A
//     snapshot of derived rows would be a second source of truth for them.
//   • The chain head state the replay compare-and-swaps against is DERIVED
//     from the snapshot's `cells` rows — `cells.event_id` IS that head (see
//     ChainHeadReplay.seedFromCellRows). One source, so a snapshot cannot
//     disagree with itself.
//   • `cells_fts`/`value_tsv` is a generated column and is never written by
//     hand; generated columns are excluded from the column set below.
//
// ── Why it fails toward a full replay ─────────────────────────────────────
//
// A snapshot is an optimization, never the authority, so every doubt resolves
// to "replay from the first event":
//
//  1. COLUMN SET IS PINNED. The manifest records the live, non-generated
//     column list of each snapshotted table, and a restore refuses a snapshot
//     whose list differs from the database's today. Without this, a column
//     added after a snapshot was written would restore as NULL on every
//     pre-snapshot row — a silently wrong projection, which is far worse than
//     a slow one.
//  2. MISSING / CORRUPT IS NOT AN ERROR. An absent manifest, unparseable JSON,
//     a wrong format version, a missing chunk, or a `snapshotSeq` ahead of the
//     project's log all read as "no snapshot" and the caller replays in full.
//  3. CONSISTENT OR NOTHING. `MAX(server_seq)` is read before the keyset walk
//     and again after it. The two projection tables here change ONLY as events
//     apply, so an unmoved high-water mark means the pages cannot have straddled
//     a write; a moved one abandons the run, and the next one tries again.
//     (A transaction would be the obvious alternative, but it would have to
//     stay open across the R2 writes, and nothing in this repo holds a
//     transaction across non-DB work — see DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS.)
//  4. THE MANIFEST IS WRITTEN LAST. Chunks live under `<snapshotSeq>/`, so a
//     torn write leaves the previous manifest pointing at its own intact
//     chunks. Superseded chunk prefixes are pruned only after the new manifest
//     lands.
//
// A snapshot is taken from the LIVE projection, so a rebuild seeded from one
// repairs the log's tail, not the snapshot itself. `?fullReplay=1` on the
// rebuild route is the from-genesis repair, and the one to reach for when the
// projection is suspected wrong rather than merely stale.
//
// R2 note: these objects live under `projection-snapshots/`, a namespace the
// AQU-1856 orphan sweep does not recognize. That sweep is an allowlist
// (r2-gc.ts `classifyKey`), so a new namespace is invisible to it — the safe
// default, and the reason nothing here needs a reference query.

import { r2KeyPrefix, type AudioEnv } from '../audio'

/** Bumped whenever the on-disk shape changes. An older format reads as "no
 *  snapshot" rather than being migrated: the log is always still there. */
export const PROJECTION_SNAPSHOT_FORMAT = 1

/** The projection tables a rebuild replays, and so the ones a snapshot holds.
 *  Order is the restore order. */
export const SNAPSHOT_TABLES = ['cells', 'cell_validators'] as const
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number]

/** Rows per R2 chunk object, and so per keyset page. Bounds the working set of
 *  both the write and the restore: neither ever holds more than one chunk of
 *  one table. Overridable per call (`chunkRows`) so a test can exercise the
 *  paging without seeding thousands of rows. */
export const SNAPSHOT_CHUNK_ROWS = 2_000

/** Rows per restore INSERT batch. `cells` is ~35 columns, so 400 rows is
 *  ~14k bound values — an order of magnitude under the driver's 65,533 cap
 *  (see DRIVER_MAX_BIND_PARAMS) with room for the table to grow wider. */
export const SNAPSHOT_RESTORE_BATCH_ROWS = 400

/** How many events past the last snapshot a project needs before it is worth
 *  snapshotting again. A snapshot's whole value is the replay it saves. */
export const SNAPSHOT_MIN_NEW_EVENTS = 5_000

export interface ProjectionSnapshotEnv extends Pick<AudioEnv, 'R2_KEY_PREFIX'> {
  SNAPSHOTS: R2Bucket
}

export interface SnapshotChunkRef {
  table: SnapshotTable
  /** Full bucket key, prefix included — read it back verbatim. */
  key: string
  rows: number
}

export interface ProjectionSnapshotManifest {
  format: number
  projectId: string
  /** The project's MAX(server_seq) at the moment the rows were read. A rebuild
   *  seeded from this snapshot replays events with `server_seq > snapshotSeq`. */
  snapshotSeq: number
  takenAt: number
  /** Live, non-generated column list per table, in ordinal order. A restore
   *  refuses a snapshot whose lists no longer match the database. */
  columns: Record<SnapshotTable, string[]>
  chunks: SnapshotChunkRef[]
  counts: Record<SnapshotTable, number>
}

/** One `cells` row, as much of it as the head-state derivation reads. */
export interface SnapshotCellRow {
  file_id: string
  cell_id: string
  side: string
  lane_id: string
  event_id: string
  upstream_seq: number | string | null
}

export function projectionSnapshotPrefix(
  env: Pick<ProjectionSnapshotEnv, 'R2_KEY_PREFIX'>,
  projectId: string,
): string {
  return `${r2KeyPrefix(env)}projection-snapshots/${projectId}/`
}

export function projectionSnapshotManifestKey(
  env: Pick<ProjectionSnapshotEnv, 'R2_KEY_PREFIX'>,
  projectId: string,
): string {
  return `${projectionSnapshotPrefix(env, projectId)}manifest.json`
}

/**
 * The columns a snapshot of `table` covers: every column the database has
 * today except generated ones, which cannot be written back.
 *
 * Read from `information_schema` rather than hard-coded, so adding a column is
 * never a silent snapshot bug — the next snapshot simply covers it, and any
 * snapshot written before it is refused by the column-set check.
 */
export async function liveSnapshotColumns(db: AquillaDb, table: SnapshotTable): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ? AND is_generated <> 'ALWAYS'
       ORDER BY ordinal_position`,
    )
    .bind(table)
    .all<{ column_name: string }>()
  return (results ?? []).map((row) => row.column_name)
}

/** JSON-safe form of one column value. A jsonb column arrives decoded and goes
 *  back as JSON text (Postgres casts it on the way in); a bigint arrives as a
 *  string or a number and either round-trips. */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    default:
      if (value instanceof Date) return value.toISOString()
      return JSON.stringify(value)
  }
}

function chunkKey(
  env: Pick<ProjectionSnapshotEnv, 'R2_KEY_PREFIX'>,
  projectId: string,
  snapshotSeq: number,
  table: SnapshotTable,
  index: number,
): string {
  return `${projectionSnapshotPrefix(env, projectId)}${snapshotSeq}/${table}-${index}.json`
}

/** Keyset order per table — its primary key, minus `project_id` (already bound). */
const KEYSET: Record<SnapshotTable, string[]> = {
  cells: ['file_id', 'cell_id', 'lane_id'],
  cell_validators: ['file_id', 'cell_id', 'lane_id', 'username'],
}

/** Read one keyset page of `table`, ordered by its primary key. */
async function readPage(
  db: AquillaDb,
  table: SnapshotTable,
  columns: readonly string[],
  projectId: string,
  after: readonly string[] | null,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const keyset = KEYSET[table]
  const order = keyset.join(', ')
  const cols = columns.join(', ')
  const where = after
    ? `WHERE project_id = ? AND (${order}) > (${keyset.map(() => '?').join(', ')})`
    : 'WHERE project_id = ?'
  const { results } = await db
    .prepare(
      `SELECT ${cols} FROM ${table} ${where}
       ORDER BY ${order} LIMIT ${limit}`,
    )
    .bind(...(after ? [projectId, ...after] : [projectId]))
    .all<Record<string, unknown>>()
  return results ?? []
}

export interface WriteSnapshotResult {
  manifest: ProjectionSnapshotManifest
  /** Chunk prefixes of superseded snapshots that were deleted. */
  prunedKeys: number
}

/**
 * Write one snapshot of `projectId`'s projection, and return its manifest.
 *
 * Returns null when there is nothing to do: the project has no events,
 * `minNewEvents` has not been reached since the last snapshot, or the project
 * took a write while the rows were being read (see the consistency check
 * below). Never throws for a skip — only for a genuine read/write failure,
 * which the caller logs and retries next run.
 */
export async function writeProjectionSnapshot(
  env: ProjectionSnapshotEnv,
  db: AquillaDb,
  projectId: string,
  options: { minNewEvents?: number; now?: number; chunkRows?: number } = {},
): Promise<WriteSnapshotResult | null> {
  const minNewEvents = options.minNewEvents ?? SNAPSHOT_MIN_NEW_EVENTS
  const chunkRows =
    options.chunkRows && options.chunkRows > 0 ? options.chunkRows : SNAPSHOT_CHUNK_ROWS
  const existing = await readProjectionSnapshot(env, projectId)

  const snapshotSeq = await maxServerSeq(db, projectId)
  if (snapshotSeq === 0) return null
  if (existing && snapshotSeq - existing.snapshotSeq < minNewEvents) return null

  const columns = {} as Record<SnapshotTable, string[]>
  const counts = {} as Record<SnapshotTable, number>
  const chunks: SnapshotChunkRef[] = []

  for (const table of SNAPSHOT_TABLES) {
    const cols = await liveSnapshotColumns(db, table)
    // No columns means the table is not there at all — not a snapshot's
    // problem to solve.
    if (cols.length === 0) return null
    columns[table] = cols
    counts[table] = 0
    const keyset = KEYSET[table]
    let after: string[] | null = null
    let index = 0
    for (;;) {
      const page = await readPage(db, table, cols, projectId, after, chunkRows)
      if (page.length === 0) break
      const rows = page.map((row) => cols.map((col) => serializeValue(row[col])))
      const key = chunkKey(env, projectId, snapshotSeq, table, index)
      await env.SNAPSHOTS.put(key, JSON.stringify({ table, columns: cols, rows }), {
        httpMetadata: { contentType: 'application/json' },
      })
      chunks.push({ table, key, rows: rows.length })
      counts[table] += rows.length
      index += 1
      if (page.length < chunkRows) break
      const last = page[page.length - 1]!
      after = keyset.map((col) => String(last[col]))
    }
  }

  // The consistency check. An event that applied while the walk was running
  // could have landed in a page already read — or in one not yet reached — so
  // the pages would describe no single moment. Throw the run away rather than
  // write a snapshot that is subtly a blend of two.
  const seqAfter = await maxServerSeq(db, projectId)
  if (seqAfter !== snapshotSeq) {
    console.log(
      `[projection-snapshot] ${projectId} moved from seq ${snapshotSeq} to ${seqAfter} mid-read — abandoning`,
    )
    await deleteKeys(env, chunks.map((c) => c.key))
    return null
  }

  const manifest: ProjectionSnapshotManifest = {
    format: PROJECTION_SNAPSHOT_FORMAT,
    projectId,
    snapshotSeq,
    takenAt: options.now ?? Date.now(),
    columns,
    counts,
    chunks,
  }

  // The manifest lands LAST — until it does, the previous snapshot is still
  // the live one and still complete.
  await env.SNAPSHOTS.put(
    projectionSnapshotManifestKey(env, projectId),
    JSON.stringify(manifest),
    { httpMetadata: { contentType: 'application/json' } },
  )

  const prunedKeys = await pruneSupersededChunks(env, projectId, snapshotSeq)
  return { manifest, prunedKeys }
}

/** The project's log high-water mark. */
async function maxServerSeq(db: AquillaDb, projectId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(server_seq), 0) AS seq FROM events WHERE project_id = ?')
    .bind(projectId)
    .first<{ seq: number | string | bigint }>()
  return Number(row?.seq ?? 0)
}

/** Best-effort delete. An object left behind is wasted bytes the next
 *  successful write's prune collects; failing the run over it would be worse. */
async function deleteKeys(env: ProjectionSnapshotEnv, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    try {
      await env.SNAPSHOTS.delete(key)
    } catch (err) {
      console.warn(`[projection-snapshot] could not delete ${key}:`, err)
    }
  }
}

/** Delete chunk objects of every snapshot but the one `keepSeq` names. Losing a
 *  prune wastes bytes and never costs correctness, so a failure is swallowed. */
async function pruneSupersededChunks(
  env: ProjectionSnapshotEnv,
  projectId: string,
  keepSeq: number,
): Promise<number> {
  const prefix = projectionSnapshotPrefix(env, projectId)
  const keep = `${prefix}${keepSeq}/`
  let deleted = 0
  try {
    let cursor: string | undefined
    for (;;) {
      const page = await env.SNAPSHOTS.list({ prefix, cursor })
      const stale = page.objects
        .map((o) => o.key)
        .filter((key) => key !== `${prefix}manifest.json` && !key.startsWith(keep))
      for (const key of stale) {
        await env.SNAPSHOTS.delete(key)
        deleted += 1
      }
      if (!page.truncated) break
      cursor = page.cursor
    }
  } catch (err) {
    console.warn(`[projection-snapshot] could not prune old chunks for ${projectId}:`, err)
  }
  return deleted
}

function isSnapshotTable(value: unknown): value is SnapshotTable {
  return typeof value === 'string' && (SNAPSHOT_TABLES as readonly string[]).includes(value)
}

/** Read the latest manifest, or null when there is not a usable one. Missing,
 *  unparseable, wrong-format and structurally invalid all read the same way:
 *  no snapshot. */
export async function readProjectionSnapshot(
  env: ProjectionSnapshotEnv,
  projectId: string,
): Promise<ProjectionSnapshotManifest | null> {
  let parsed: unknown
  try {
    const obj = await env.SNAPSHOTS.get(projectionSnapshotManifestKey(env, projectId))
    if (!obj) return null
    parsed = JSON.parse(await obj.text())
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const m = parsed as Partial<ProjectionSnapshotManifest>
  if (m.format !== PROJECTION_SNAPSHOT_FORMAT) return null
  if (m.projectId !== projectId) return null
  if (typeof m.snapshotSeq !== 'number' || !Number.isFinite(m.snapshotSeq) || m.snapshotSeq <= 0) {
    return null
  }
  if (!m.columns || typeof m.columns !== 'object') return null
  if (!Array.isArray(m.chunks)) return null
  for (const table of SNAPSHOT_TABLES) {
    if (!Array.isArray(m.columns[table]) || m.columns[table].length === 0) return null
  }
  for (const chunk of m.chunks) {
    if (!chunk || typeof chunk !== 'object') return null
    if (!isSnapshotTable(chunk.table) || typeof chunk.key !== 'string') return null
  }
  return m as ProjectionSnapshotManifest
}

/** Raised when a snapshot turns out to be unusable mid-restore. The caller
 *  catches it and replays the log in full. */
export class SnapshotUnusableError extends Error {}

/** Refuse a snapshot whose column set no longer matches the database. */
export async function assertSnapshotColumnsCurrent(
  db: AquillaDb,
  manifest: ProjectionSnapshotManifest,
): Promise<void> {
  for (const table of SNAPSHOT_TABLES) {
    const live = await liveSnapshotColumns(db, table)
    const stored = manifest.columns[table]
    if (live.length !== stored.length || live.some((col, i) => col !== stored[i])) {
      throw new SnapshotUnusableError(
        `snapshot ${manifest.snapshotSeq} predates the current ${table} columns ` +
          `(snapshot: ${stored.join(',')}; live: ${live.join(',')})`,
      )
    }
  }
}

/** Read one chunk back. A missing or malformed chunk makes the whole snapshot
 *  unusable — a partial restore is the one outcome worse than a slow rebuild. */
async function readChunk(
  env: ProjectionSnapshotEnv,
  manifest: ProjectionSnapshotManifest,
  chunk: SnapshotChunkRef,
): Promise<unknown[][]> {
  let parsed: unknown
  try {
    const obj = await env.SNAPSHOTS.get(chunk.key)
    if (!obj) throw new Error('object missing')
    parsed = JSON.parse(await obj.text())
  } catch (err) {
    throw new SnapshotUnusableError(`chunk ${chunk.key} is unreadable: ${String(err)}`)
  }
  const rows = (parsed as { rows?: unknown })?.rows
  if (!Array.isArray(rows)) throw new SnapshotUnusableError(`chunk ${chunk.key} has no rows array`)
  const width = manifest.columns[chunk.table].length
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== width) {
      throw new SnapshotUnusableError(
        `chunk ${chunk.key} has a row of ${Array.isArray(row) ? row.length : '?'} values, expected ${width}`,
      )
    }
  }
  return rows as unknown[][]
}

export interface RestoredSnapshot {
  manifest: ProjectionSnapshotManifest
  rowsRestored: Record<SnapshotTable, number>
  /** Every `cells` row restored, for the head-state seed. Held as the narrow
   *  SnapshotCellRow shape, not the full row. */
  cellRows: SnapshotCellRow[]
}

/**
 * Insert a snapshot's rows into the (already emptied) projection tables.
 *
 * Throws SnapshotUnusableError when the snapshot cannot be trusted; the caller
 * must then wipe whatever landed and replay the log in full.
 */
export async function restoreProjectionSnapshot(
  env: ProjectionSnapshotEnv,
  db: AquillaDb,
  manifest: ProjectionSnapshotManifest,
): Promise<RestoredSnapshot> {
  await assertSnapshotColumnsCurrent(db, manifest)

  const rowsRestored = { cells: 0, cell_validators: 0 } as Record<SnapshotTable, number>
  const cellRows: SnapshotCellRow[] = []

  for (const table of SNAPSHOT_TABLES) {
    const cols = manifest.columns[table]
    const cellIndex =
      table === 'cells'
        ? {
            file_id: cols.indexOf('file_id'),
            cell_id: cols.indexOf('cell_id'),
            side: cols.indexOf('side'),
            lane_id: cols.indexOf('lane_id'),
            event_id: cols.indexOf('event_id'),
            upstream_seq: cols.indexOf('upstream_seq'),
          }
        : null
    if (cellIndex && Object.values(cellIndex).some((i) => i < 0)) {
      throw new SnapshotUnusableError('snapshot cells chunk is missing a chain-head column')
    }

    const colSql = cols.join(', ')
    for (const chunk of manifest.chunks.filter((c) => c.table === table)) {
      const rows = await readChunk(env, manifest, chunk)
      for (let i = 0; i < rows.length; i += SNAPSHOT_RESTORE_BATCH_ROWS) {
        const batch = rows.slice(i, i + SNAPSHOT_RESTORE_BATCH_ROWS)
        const values = batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
        await db
          .prepare(`INSERT INTO ${table} (${colSql}) VALUES ${values}`)
          .bind(...batch.flat())
          .run()
      }
      rowsRestored[table] += rows.length
      if (cellIndex) {
        for (const row of rows) {
          cellRows.push({
            file_id: String(row[cellIndex.file_id]),
            cell_id: String(row[cellIndex.cell_id]),
            side: String(row[cellIndex.side]),
            lane_id: String(row[cellIndex.lane_id]),
            event_id: String(row[cellIndex.event_id]),
            upstream_seq: row[cellIndex.upstream_seq] as number | string | null,
          })
        }
      }
    }
  }

  return { manifest, rowsRestored, cellRows }
}
