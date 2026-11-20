// AQU-2658 — find, and put back, the source cells a metadata merge damaged.
//
// A source link's mirror stores a cell's envelope as a double-encoded JSON
// string. Until AQU-2658 a `source.cell.metadata.patch` merged into it with a
// plain `||`, and `string || object` is an array: the row was left holding
// `["<envelope json>", {}]`. No reader takes an array for metadata, so the cell
// lost its IDML locator and the file's InDesign export stopped on it. "Place
// translations" did this to every validated line it placed, because its
// markup-only save is that event with an empty patch.
//
// The projection no longer does it (`cellMetadataMergeBaseSql`). This is for
// the rows it already did it to.
//
// THE ONE THING IT WRITES TO A CELL is a value the row itself already holds: the
// array's first element, which is byte for byte what `metadata` was before the
// merge. And only where the rest of the array is nothing but empty patches —
// where putting the first element back loses nothing, because nothing was added.
// An array that does not read that way (a patch that carried keys, a first
// element that is not a string-encoded object) is counted, reported, and left
// exactly as it is for a person to look at.
//
// AND THEN IT HAS TO SAY SO. A browser keeps each file's cells in IndexedDB
// with the file's event-log watermark, and on reopen asks only for what changed
// since (`GET /cells?since=`). Putting a row back mints no event, so the answer
// is "nothing newer" and the browser goes on showing the damaged row it cached:
// production's first repair (2026-11-20, Russian BSB) restored 51 cells and the
// export went on failing on them. A projection rebuild has the same problem and
// solves it with the project's rebuild marker, which the read route answers
// with a full resync. `repairProjectCellMetadata` moves that marker in the same
// transaction as the rows.

import type { AquillaDb } from "../shim/postgres"

/**
 * True for a `cells.metadata` that is exactly what an empty patch left behind:
 * `["<json object, as a string>", {}, …]`.
 *
 * Nested CASEs, not ANDs: Postgres promises not to evaluate a CASE branch it
 * does not take, and makes no such promise about the operands of AND. So the
 * cast only sees text `pg_input_is_valid` accepted, and
 * `jsonb_array_elements` only ever sees an array.
 */
export const RESTORABLE_CELL_METADATA_SQL = `CASE WHEN jsonb_typeof(metadata) = 'array' THEN
    CASE WHEN jsonb_array_length(metadata) >= 2 AND jsonb_typeof(metadata -> 0) = 'string' THEN
      CASE WHEN pg_input_is_valid(metadata ->> 0, 'jsonb') THEN
        jsonb_typeof((metadata ->> 0)::jsonb) = 'object'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(metadata) WITH ORDINALITY AS patch(item, position)
           WHERE patch.position > 1 AND patch.item <> '{}'::jsonb
        )
      ELSE false END
    ELSE false END
  ELSE false END`

export interface DamagedCellMetadataFile {
  projectId: string
  projectName: string | null
  fileId: string
  fileName: string | null
  /** Source cells whose metadata is an array. Nothing writes one on purpose. */
  damaged: number
  /** Of those, the ones `restoreDamagedCellMetadata` puts back. */
  restorable: number
}

interface DamagedRow {
  project_id: string
  project_name: string | null
  file_id: string
  file_name: string | null
  damaged: number | string
  restorable: number | string
}

/**
 * Every file that holds a source cell whose metadata is an array, with how
 * many of them can be put back. Reads only.
 *
 * With `projectId` this is an index scan of one project. Without it, it reads
 * every source cell in the database: minutes, not seconds, on production.
 */
export async function listDamagedCellMetadata(
  db: AquillaDb,
  opts: { projectId?: string } = {},
): Promise<DamagedCellMetadataFile[]> {
  const scope = opts.projectId ? "AND project_id = ?" : ""
  const { results } = await db
    .prepare(
      `SELECT d.project_id, p.name AS project_name, d.file_id, f.name AS file_name, d.damaged, d.restorable
         FROM (
           SELECT project_id, file_id,
                  COUNT(*) AS damaged,
                  COUNT(*) FILTER (WHERE ${RESTORABLE_CELL_METADATA_SQL}) AS restorable
             FROM cells
            WHERE side = 'source' AND jsonb_typeof(metadata) = 'array' ${scope}
            GROUP BY project_id, file_id
         ) d
         LEFT JOIN projects p ON p.id = d.project_id
         LEFT JOIN files f ON f.id = d.file_id AND f.project_id = d.project_id
        ORDER BY d.project_id, d.file_id`,
    )
    .bind(...(opts.projectId ? [opts.projectId] : []))
    .all<DamagedRow>()
  return results.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    fileId: row.file_id,
    fileName: row.file_name,
    damaged: Number(row.damaged),
    restorable: Number(row.restorable),
  }))
}

/**
 * Put one file's restorable cells back to the value they held before the
 * merge. Returns how many rows it wrote. One statement, so it is all of the
 * file's cells or none; and the predicate is re-read by the UPDATE itself, so
 * a row that changed since the listing is judged as it is now.
 */
export async function restoreDamagedCellMetadata(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE cells SET metadata = metadata -> 0
        WHERE project_id = ? AND file_id = ? AND side = 'source'
          AND ${RESTORABLE_CELL_METADATA_SQL}`,
    )
    .bind(projectId, fileId)
    .run()
  return result.meta.changes
}

/**
 * Move the project's rebuild marker, so every client holding its cells reads
 * them again in full. Returns the new marker.
 *
 * This is the statement a projection rebuild ends with
 * (`sync-worker/src/events/rebuild.ts`, step 5) — keep the two the same. It
 * takes one seq from the project's own counter, the one live event writes use,
 * and records it as `rebuilt_seq`: strictly above every cursor a client could
 * hold, so even a fully caught-up one trips the read route's
 * `since < rebuilt_seq` resync, and the ETag changes with it. The seq it
 * consumes is a gap in the log, as harmless as an idempotent replay's.
 */
export async function markProjectionRepaired(db: AquillaDb, projectId: string): Promise<number> {
  const marker = await db
    .prepare(
      `INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq)
       SELECT ?, seed.next_seq, seed.next_seq
       FROM (SELECT COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1 AS next_seq) seed
       ON CONFLICT (project_id) DO UPDATE SET
         last_seq    = GREATEST(project_seq_counters.last_seq + 1, excluded.last_seq),
         rebuilt_seq = GREATEST(project_seq_counters.last_seq + 1, excluded.last_seq)
       RETURNING last_seq`,
    )
    .bind(projectId, projectId)
    .first<number | string | bigint>("last_seq")
  return Number(marker ?? 0)
}

export interface ProjectCellMetadataRepair {
  /** Rows written, by file. */
  restoredByFile: Record<string, number>
  restored: number
  /** The rebuild marker this run set, or null when it had no reason to. */
  resyncMarker: number | null
}

/**
 * Repair one project: put back the restorable cells of each file named, and
 * tell its clients to read the project again.
 *
 * The marker moves only when a row did, so a second apply writes nothing at
 * all. `resync: true` moves it regardless: for a project whose rows were put
 * back by something that did not (production and dev, both, before this
 * existed), where the cells are right and every browser that had them open is
 * still showing the old ones.
 *
 * One transaction: rows first, marker after. In the other order a client could
 * resync between the two, cache the damaged rows again under a cursor above
 * the marker, and never be told.
 */
export async function repairProjectCellMetadata(
  db: AquillaDb,
  projectId: string,
  fileIds: readonly string[],
  opts: { resync?: boolean } = {},
): Promise<ProjectCellMetadataRepair> {
  const run = async (tx: AquillaDb): Promise<ProjectCellMetadataRepair> => {
    const restoredByFile: Record<string, number> = {}
    let restored = 0
    for (const fileId of fileIds) {
      const count = await restoreDamagedCellMetadata(tx, projectId, fileId)
      restoredByFile[fileId] = count
      restored += count
    }
    const resyncMarker = restored > 0 || opts.resync ? await markProjectionRepaired(tx, projectId) : null
    return { restoredByFile, restored, resyncMarker }
  }
  if (!db.transaction) throw new Error("repairProjectCellMetadata needs a database handle with transactions")
  return db.transaction(run)
}
