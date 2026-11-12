// The import envelope of a cell a source link mirrored before the link carried
// one.
//
// A live link has copied each cell's `metadata` since AQU-1520 (2026-10-01).
// The projects linked before that — every EBL language project, 2026-09-22 —
// hold source cells whose `metadata` is NULL, and the fold never comes back for
// them: it reads only what the upstream changed since the link's cursor, and a
// finished upstream changes nothing. AQU-1520 left those rows alone on purpose,
// because all they lost then was the section navigator's titles.
//
// AQU-2345/AQU-2438 changed what the gap costs. A mirrored IDML file now reads
// as IDML and points at the upstream's original, so the export dialog offers
// the InDesign download — and the exporter addresses every paragraph through
// `metadata.idml` and `metadata.aquillaImport.sourceLocator`. With no envelope
// the first cell fails: "has no supported IDML v2 locator. Re-import the
// original IDML to repair it." The same NULL also hides the cell's protected
// runs from the editor, so translators typed into those files as plain text.
//
// The repair is the upstream's own envelope, written through the event that
// exists for exactly this — `source.cell.metadata.patch`, which merges into
// `cells.metadata` without moving the source's `event_id`, so no translation
// goes stale and no validation is touched. Three rules keep it safe:
//
//   - only a NULL is filled. A cell that has any metadata keeps it;
//   - only where the copy still holds the upstream's text. The envelope
//     describes the upstream's CURRENT paragraph (its runs, its anchor hash);
//     on a copy whose text is behind, it would describe a paragraph the copy
//     does not have. `mirrorSync` therefore runs this only once the fold has
//     caught up, and the read compares `value` cell by cell on top of that;
//   - the protected source HTML rides along when the copy's differs, so the
//     envelope and the HTML it was computed from always arrive as a pair.
//
// Bounded per call: a project's worth of envelopes is a few megabytes of
// JSON, so a call repairs at most ENVELOPE_REPAIR_CELLS cells and reports
// `more`, which the link-sync route already answers by calling again.
//
// Event ids are deterministic per cell, so a call that died between the event
// insert and the projection is finished by the next one: the insert is a
// no-op, the projection runs, and the cell leaves the NULL set.

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import type { LinkedFilePair } from '../../../db/shared/link-file-provenance'
import {
  allocateSeqRange,
  buildBulkEventInsertStmts,
  buildSettleSeqRangeStmt,
  type SeqEventInsertRow,
} from './event-insert'
import { buildEventProjectionStmts, type PersistedEvent } from './event-projection'
import type { EventPayloads } from './types'

/** The most cells one call repairs. A window of the fold holds 2,000 events;
 *  an envelope is several times the size of a mirrored line, so half that. */
export const ENVELOPE_REPAIR_CELLS = 1000

/** `source.cell.metadata.patch` is a schema-version-2 event (see the
 *  projection, which refuses any other). */
const PATCH_SCHEMA_VERSION = 2
const BATCH_LIMIT = 100
/** Pairs per read: two binds each, well inside what one statement carries. */
const PAIR_PAGE = 200

export interface MirroredEnvelopeRepairArgs {
  upstreamProjectId: string
  downstreamProjectId: string
  /** The link's copies, as the provenance sweep paired them. */
  pairs: readonly LinkedFilePair[]
  /** A stable event id for a key — `deterministicMirrorEventId`, handed in so
   *  this module does not import the fold that calls it. */
  eventId: (key: string) => string
  author: string
  now: number
  /** Cells per call (default ENVELOPE_REPAIR_CELLS). */
  limit?: number
  /** Count every cell a repair would write (the limit does not apply); write
   *  nothing. */
  dryRun?: boolean
}

export interface MirroredEnvelopeRepairResult {
  /** Cells whose envelope this call wrote — or, dry, every cell that lacks one. */
  repaired: number
  /** The call stopped at its limit; another call has more to do. */
  more: boolean
}

interface MissingEnvelopeRow {
  file_id: string
  cell_id: string
  metadata: unknown
  upstream_html: string | null
  downstream_html: string | null
}

/**
 * `cells.metadata` as the object the patch event carries, or null.
 *
 * The column is JSONB, but rows written through some paths hold the envelope
 * as a JSON string scalar rather than an object; both are the same envelope.
 * Anything else (an array, a number, unparseable text) is not one.
 */
export function envelopeObject(value: unknown): Record<string, unknown> | null {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return null
    }
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
  return Object.keys(candidate).length > 0 ? (candidate as Record<string, unknown>) : null
}

/** The copies' cells that have no envelope where the upstream's cell has one
 *  and still reads the same — the FROM/WHERE both reads below share. Binds:
 *  the page's pairs (upstream, downstream), then the two project ids. */
function missingEnvelopeSql(pairCount: number): string {
  const values = Array.from({ length: pairCount }, () => '(?::text, ?::text)').join(', ')
  return `FROM (VALUES ${values}) AS pair(upstream_file_id, downstream_file_id)
           JOIN cells d
             ON d.project_id = ? AND d.file_id = pair.downstream_file_id AND d.side = 'source'
           JOIN cells u
             ON u.project_id = ? AND u.file_id = pair.upstream_file_id
            AND u.cell_id = d.cell_id AND u.side = 'source'
          WHERE d.metadata IS NULL AND d.tombstoned_at IS NULL
            AND jsonb_typeof(u.metadata) IN ('object', 'string') AND u.tombstoned_at IS NULL
            AND d.value IS NOT DISTINCT FROM u.value`
}

function missingEnvelopeBinds(args: MirroredEnvelopeRepairArgs, page: readonly LinkedFilePair[]): string[] {
  return [
    ...page.flatMap((pair) => [pair.upstreamFileId, pair.downstreamFileId]),
    args.downstreamProjectId,
    args.upstreamProjectId,
  ]
}

/** At most `limit` of them, with the upstream's envelope. */
async function loadMissingEnvelopes(
  db: AquillaDb,
  args: MirroredEnvelopeRepairArgs,
  limit: number,
): Promise<MissingEnvelopeRow[]> {
  const out: MissingEnvelopeRow[] = []
  for (let i = 0; i < args.pairs.length && out.length < limit; i += PAIR_PAGE) {
    const page = args.pairs.slice(i, i + PAIR_PAGE)
    const rows = await db
      .prepare(
        `SELECT d.file_id, d.cell_id, u.metadata,
                u.value_html AS upstream_html, d.value_html AS downstream_html
           ${missingEnvelopeSql(page.length)}
          ORDER BY d.file_id, d.cell_id
          LIMIT ?`,
      )
      .bind(...missingEnvelopeBinds(args, page), limit - out.length)
      .all<MissingEnvelopeRow>()
    out.push(...(rows.results ?? []))
  }
  return out
}

/** How many there are — the dry run's answer, without reading an envelope. */
async function countMissingEnvelopes(db: AquillaDb, args: MirroredEnvelopeRepairArgs): Promise<number> {
  let total = 0
  for (let i = 0; i < args.pairs.length; i += PAIR_PAGE) {
    const page = args.pairs.slice(i, i + PAIR_PAGE)
    const count = await db
      .prepare(`SELECT COUNT(*) AS n ${missingEnvelopeSql(page.length)}`)
      .bind(...missingEnvelopeBinds(args, page))
      .first<number | string>('n')
    total += Number(count ?? 0)
  }
  return total
}

/**
 * Give the link's copies the envelope their upstream cells carry, where they
 * have none. See the header for the rules. Safe to call on every sync: once a
 * project is repaired the read returns nothing and nothing is written.
 */
export async function repairMirroredCellEnvelopes(
  db: AquillaDb,
  args: MirroredEnvelopeRepairArgs,
): Promise<MirroredEnvelopeRepairResult> {
  if (args.pairs.length === 0 || args.upstreamProjectId === args.downstreamProjectId) {
    return { repaired: 0, more: false }
  }
  if (args.dryRun) return { repaired: await countMissingEnvelopes(db, args), more: false }
  const limit = Math.max(1, args.limit ?? ENVELOPE_REPAIR_CELLS)
  const rows = await loadMissingEnvelopes(db, args, limit)

  const eventRows: SeqEventInsertRow[] = []
  const persisted: PersistedEvent[] = []
  for (const row of rows) {
    const metadata = envelopeObject(row.metadata)
    // Not an envelope after all (see envelopeObject): nothing to give this
    // cell. It stays NULL and is read again next time, which is the price of
    // not guessing; no real upstream row has been seen in this shape.
    if (!metadata) continue
    const payload: EventPayloads['source.cell.metadata.patch'] = {
      version: 1,
      metadata,
      ...(row.upstream_html != null && row.upstream_html !== row.downstream_html
        ? { valueHtml: row.upstream_html }
        : {}),
    }
    const id = args.eventId(`envelope:${args.upstreamProjectId}:${row.file_id}:${row.cell_id}`)
    const base = {
      id,
      schemaVersion: PATCH_SCHEMA_VERSION,
      projectId: args.downstreamProjectId,
      fileId: row.file_id,
      cellId: row.cell_id,
      parentId: null,
      kind: 'source.cell.metadata.patch' as const,
      author: args.author,
      clientTs: args.now,
      serverTs: args.now,
      serverSeq: 0,
    }
    eventRows.push({ ...base, payloadJson: JSON.stringify(payload) })
    persisted.push({ ...base, payload })
  }

  // `more` only when this call has something to show for itself: a page of
  // rows that all turned out not to be envelopes must not ask to be called
  // again, or the caller would loop on them.
  const more = rows.length >= limit && eventRows.length > 0
  if (eventRows.length === 0) return { repaired: 0, more: false }

  const baseSeq = await allocateSeqRange(db, args.downstreamProjectId, eventRows.length)
  for (let i = 0; i < eventRows.length; i++) {
    eventRows[i].serverSeq = baseSeq + i
    persisted[i].serverSeq = baseSeq + i
  }
  const stmts: AquillaStatement[] = buildBulkEventInsertStmts(db, eventRows)
  for (const event of persisted) buildEventProjectionStmts(db, event, stmts)
  stmts.push(buildSettleSeqRangeStmt(db, args.downstreamProjectId, baseSeq))
  for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
    const chunk = stmts.slice(i, i + BATCH_LIMIT)
    if (db.batchPipelined) await db.batchPipelined(chunk)
    else await db.batch(chunk)
  }
  return { repaired: eventRows.length, more }
}
