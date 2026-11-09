// AQU-2459: apply a revision — the manifest shape, the adopt loader, and the
// set-based `cells` statements. HTTP lives in revisions-route.ts; the pure
// alignment lives in db/shared/file-revision.ts. This module is the glue that
// turns an aligned delta into SQL, and it is the only place that decides how a
// revision lands in the projection:
//
//   * `equal` and `moved` units KEEP their source row's event_id. The AD-9 pin
//     is `cells.source_event_id == source.event_id` and the stale route confirms
//     a mismatch against the pinned event's payload text, so a bulk revision
//     event cannot be the pin for every cell — it carries no per-cell text. By
//     leaving unchanged rows alone, every target pinned to them stays fresh.
//   * `changed` and `inserted` units take the revision event id. A target
//     pinned to the old event now differs, and the stale route compares the old
//     event's text with the new value: stale, exactly as a source.cell.commit
//     would read today.
//   * `deleted` units are tombstoned, never hard-deleted (AQU-476's rule), so
//     an orphaned translation stays joinable.
//
// Phase A of the spec: the `cells` source rows are still projected, one
// statement per 1000 rows, with no per-cell events and no chain claims.

import type { AlignedUnit, RevisionManifest, RevisionUnit, RevisionUnitInput } from '../../../db/shared/file-revision'
import { contentHashOf } from '../../../db/shared/file-revision'
import { buildBulkSourceCellCreateStmt, type PersistedEvent } from './event-projection'
import { walkAnchorChain } from './cells-read-route'

/** A manifest unit also remembers which event its source row carries. */
export type StoredRevisionUnit = RevisionUnit & { readonly eventId: string }

export interface StoredRevisionManifest extends Omit<RevisionManifest, 'units'> {
  readonly units: readonly StoredRevisionUnit[]
  /** True when revision 1 was written from a materialized file's cells. */
  readonly adopted?: boolean
}

export const CELL_UPSERT_ROWS = 1000

interface SourceCellRow {
  cell_id: string
  anchor_cell_id: string | null
  event_id: string
  value: string
  value_html: string | null
  type: string | null
  canonical_ref: string | null
  sequence_index: number | null
  metadata: unknown
}

/**
 * Read a materialized file's live source cells in document order, shaped as
 * revision-1 units that KEEP their cell ids and event ids. Returns null when
 * the file has no source rows (a fresh file needs no adoption).
 */
export async function loadAdoptableUnits(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<StoredRevisionUnit[] | null> {
  const result = await db
    .prepare(
      `SELECT cell_id, anchor_cell_id, event_id, value, value_html, type, canonical_ref, sequence_index, metadata
       FROM cells
       WHERE project_id = ? AND file_id = ? AND side = 'source' AND tombstoned_at IS NULL`,
    )
    .bind(projectId, fileId)
    .all<SourceCellRow>()
  const rows = result.results ?? []
  if (rows.length === 0) return null
  const ordered = walkAnchorChain(rows)
  const seen = new Map<string, number>()
  return ordered.map((row, index) => {
    const meta = parseMetadata(row.metadata)
    const envelope = meta.aquillaImport as { unitKey?: unknown } | undefined
    const importKey = typeof envelope?.unitKey === 'string' && envelope.unitKey ? envelope.unitKey : null
    let unitKey = row.canonical_ref ?? importKey ?? `cell:${row.cell_id}`
    const n = (seen.get(unitKey) ?? 0) + 1
    seen.set(unitKey, n)
    if (n > 1) unitKey = `${unitKey}#${n}`
    return {
      unitKey,
      // A verse-addressed cell pairs by reference; everything else is positional.
      positional: !row.canonical_ref,
      text: row.value,
      ...(row.value_html ? { html: row.value_html } : {}),
      ...(row.type ? { type: row.type } : {}),
      ...(row.canonical_ref ? { canonicalRef: row.canonical_ref } : {}),
      sequenceIndex: row.sequence_index ?? index,
      metadata: meta,
      cellId: row.cell_id,
      contentHash: contentHashOf(row.value),
      eventId: row.event_id,
    }
  })
}

/**
 * The head manifest describes `cells` only until a per-cell source write lands
 * on the file (a source edit, split, /import/reconcile, agent insert, mirror
 * window). Compare the live source rows with the head, in order, by cell id and
 * event id. Equal: returns null, the head is current. Different: returns the
 * live rows as units, keeping the head's unitKey/positional for cells the head
 * already knew (so alignment keys stay stable) and a derived key for the rest.
 */
export function liveUnitsIfDrifted(
  head: StoredRevisionManifest,
  live: readonly StoredRevisionUnit[] | null,
): StoredRevisionUnit[] | null {
  const rows = live ?? []
  const same =
    rows.length === head.units.length &&
    rows.every((u, i) => u.cellId === head.units[i].cellId && u.eventId === head.units[i].eventId)
  if (same) return null
  const known = new Map(head.units.map((u) => [u.cellId, u]))
  // Keys the head already gave a live cell are reserved first, so a new cell
  // can never take one and push a known cell off its own key.
  const used = new Set(rows.flatMap((u) => (known.has(u.cellId) ? [known.get(u.cellId)!.unitKey] : [])))
  return rows.map((u) => {
    const prior = known.get(u.cellId)
    if (prior) return { ...u, unitKey: prior.unitKey, positional: prior.positional }
    let unitKey = u.unitKey
    for (let n = 2; used.has(unitKey); n++) unitKey = `${u.unitKey}#${n}`
    used.add(unitKey)
    return { ...u, unitKey }
  })
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* not JSON */
    }
  }
  return {}
}

/** Which event a unit's source row carries after this revision. */
export function unitEventId(aligned: AlignedUnit, revisionEventId: string): string {
  if ((aligned.outcome === 'equal' || aligned.outcome === 'moved') && aligned.parent) {
    const parent = aligned.parent as Partial<StoredRevisionUnit>
    if (parent.eventId) return parent.eventId
  }
  return revisionEventId
}

export interface CellsApplyArgs {
  projectId: string
  fileId: string
  revisionEventId: string
  author: string
  serverTs: number
  clientTs: number
  units: readonly AlignedUnit[]
  deleted: readonly RevisionUnit[]
}

/**
 * The `cells` statements for one revision: every unit upserted in document
 * order (anchor = previous unit), deleted units tombstoned. Reuses the import
 * route's bulk upsert so the column list cannot drift from `source.cell.create`.
 */
export function buildRevisionCellStmts(db: AquillaDb, args: CellsApplyArgs): AquillaStatement[] {
  return cellStmtsForUnits(db, {
    projectId: args.projectId,
    fileId: args.fileId,
    author: args.author,
    serverTs: args.serverTs,
    clientTs: args.clientTs,
    units: args.units.map((aligned) => ({ unit: aligned.unit, eventId: unitEventId(aligned, args.revisionEventId) })),
    deletedCellIds: args.deleted.map((u) => u.cellId),
  })
}

/**
 * The same statements from a STORED manifest — what a projection rebuild
 * replays for a `file.revision` event once it has the manifest from R2. The
 * tombstones are the previous manifest's cell ids that this one no longer
 * carries, so replaying r1 then r2 lands exactly where the live route did.
 */
export function buildCellStmtsFromManifest(
  db: AquillaDb,
  args: {
    projectId: string
    fileId: string
    manifest: StoredRevisionManifest
    previousCellIds: ReadonlySet<string>
    author: string
    serverTs: number
  },
): AquillaStatement[] {
  const current = new Set(args.manifest.units.map((u) => u.cellId))
  return cellStmtsForUnits(db, {
    projectId: args.projectId,
    fileId: args.fileId,
    author: args.author,
    serverTs: args.serverTs,
    clientTs: args.serverTs,
    units: args.manifest.units.map((unit) => ({ unit, eventId: unit.eventId })),
    deletedCellIds: [...args.previousCellIds].filter((id) => !current.has(id)),
  })
}

function cellStmtsForUnits(
  db: AquillaDb,
  args: {
    projectId: string
    fileId: string
    author: string
    serverTs: number
    clientTs: number
    units: ReadonlyArray<{ unit: RevisionUnit; eventId: string }>
    deletedCellIds: readonly string[]
  },
): AquillaStatement[] {
  const stmts: AquillaStatement[] = []
  const events: PersistedEvent[] = args.units.map(({ unit: u, eventId }, index) => ({
    id: eventId,
    schemaVersion: 1,
    projectId: args.projectId,
    fileId: args.fileId,
    cellId: u.cellId,
    parentId: null,
    kind: 'source.cell.create',
    author: args.author,
    payload: {
      cellId: u.cellId,
      anchorCellId: index === 0 ? null : args.units[index - 1].unit.cellId,
      value: u.text,
      ...(u.html !== undefined ? { valueHtml: u.html } : {}),
      ...(u.type !== undefined ? { type: u.type } : {}),
      ...(u.canonicalRef !== undefined ? { canonicalRef: u.canonicalRef } : {}),
      sequenceIndex: u.sequenceIndex,
      ...(u.metadata !== undefined ? { metadata: u.metadata } : {}),
    },
    clientTs: args.clientTs,
    serverTs: args.serverTs,
  }))
  for (let i = 0; i < events.length; i += CELL_UPSERT_ROWS) {
    stmts.push(buildBulkSourceCellCreateStmt(db, events.slice(i, i + CELL_UPSERT_ROWS)))
  }
  for (let i = 0; i < args.deletedCellIds.length; i += CELL_UPSERT_ROWS) {
    const chunk = args.deletedCellIds.slice(i, i + CELL_UPSERT_ROWS)
    stmts.push(
      db
        .prepare(
          // Hidden as well as tombstoned: the editor hides `hidden_at` rows
          // (the reconcile re-import's treatment of a removed unit) and would
          // otherwise list a tombstoned row as a live one. An earlier hide keeps
          // its own time.
          `UPDATE cells SET tombstoned_at = ?, hidden_at = COALESCE(hidden_at, ?), last_edit_at = ?
           WHERE project_id = ? AND file_id = ? AND side = 'source' AND tombstoned_at IS NULL
             AND cell_id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .bind(args.serverTs, args.serverTs, args.serverTs, args.projectId, args.fileId, ...chunk),
    )
  }
  return stmts
}

/** Build the manifest that is written to R2 for this revision. */
export function buildStoredManifest(
  base: Omit<RevisionManifest, 'units'>,
  units: readonly AlignedUnit[],
  revisionEventId: string,
  adopted = false,
): StoredRevisionManifest {
  return {
    ...base,
    ...(adopted ? { adopted: true } : {}),
    units: units.map((aligned) => ({ ...aligned.unit, eventId: unitEventId(aligned, revisionEventId) })),
  }
}

/** Shape check for the units a client POSTs; returns the first problem. */
export function validateUnitInputs(raw: unknown): { ok: true; units: RevisionUnitInput[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'units must be an array' }
  const units: RevisionUnitInput[] = []
  for (let i = 0; i < raw.length; i++) {
    const u = raw[i] as Record<string, unknown> | null
    if (!u || typeof u !== 'object') return { ok: false, reason: `units[${i}] must be an object` }
    if (typeof u.unitKey !== 'string' || !u.unitKey) return { ok: false, reason: `units[${i}].unitKey must be a non-empty string` }
    if (typeof u.positional !== 'boolean') return { ok: false, reason: `units[${i}].positional must be a boolean` }
    if (typeof u.text !== 'string') return { ok: false, reason: `units[${i}].text must be a string` }
    if (u.html !== undefined && typeof u.html !== 'string') return { ok: false, reason: `units[${i}].html must be a string` }
    if (u.type !== undefined && typeof u.type !== 'string') return { ok: false, reason: `units[${i}].type must be a string` }
    if (u.canonicalRef !== undefined && typeof u.canonicalRef !== 'string') return { ok: false, reason: `units[${i}].canonicalRef must be a string` }
    if (u.metadata !== undefined && (!u.metadata || typeof u.metadata !== 'object' || Array.isArray(u.metadata))) {
      return { ok: false, reason: `units[${i}].metadata must be an object` }
    }
    units.push({
      unitKey: u.unitKey,
      positional: u.positional,
      text: u.text,
      ...(u.html !== undefined ? { html: u.html } : {}),
      ...(u.type !== undefined ? { type: u.type } : {}),
      ...(u.canonicalRef !== undefined ? { canonicalRef: u.canonicalRef } : {}),
      sequenceIndex: typeof u.sequenceIndex === 'number' && Number.isInteger(u.sequenceIndex) ? u.sequenceIndex : i,
      ...(u.metadata !== undefined ? { metadata: u.metadata as Record<string, unknown> } : {}),
    })
  }
  return { ok: true, units }
}
