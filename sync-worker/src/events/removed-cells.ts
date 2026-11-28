// AQU-1068: which source cells has this file LOST, and where did they sit?
//
// WHY THIS EXISTS. Every native export patches translations back into the
// client's own file, and leaves a paragraph alone when it has no translation.
// A removed cell has no translation either — it has nothing at all, because
// `source.cell.delete` HARD-DELETES the projection row (see the delete case in
// event-projection.ts; `cells` has no tombstone column for this path). So a
// removal is indistinguishable from "not translated yet", and every exporter
// silently re-emits the client's original text for a line somebody deliberately
// took out. The removal is undone at export, quietly, in every native format.
//
// The only durable record of a removal is the `events` log, and the only record
// of WHERE the removed cell sat is its own `source.cell.create` payload, which
// carries both `canonicalRef` (USFM's verse address) and `metadata` (the
// package locator that docx/pptx export by). Hence this module.
//
// TWO CONDITIONS, AND BOTH ARE LOAD-BEARING:
//
//   1. a `source.cell.delete` exists for the cell, and
//   2. no live source row remains for it.
//
// The delete event alone is not proof. Deletes are chain-arbitrated, so one can
// be accepted and then lose its AD-2 slot, having applied nothing — and while a
// deleted cell id can never be REUSED, an event log that already contains a
// later create for the same id (an import chunk re-sending it, a migration
// replay) would otherwise read as a removal. The live-row check is the
// authority; the event tells us the disappearance was deliberate.
//
// AND NEVER INFER A REMOVAL FROM AN UNCLAIMED SLOT. It is tempting to say "a
// paragraph in the package that no live cell claims must have been removed" and
// skip this query entirely. That is wrong and destructive: paragraphs that were
// never imported as cells at all — running heads, empty paragraphs, non-text
// frames — look exactly the same, and dropping those would damage the client's
// document.

import type { AquillaDb } from '../../../db/shim/postgres'
import { loadVirtualSourceFile, type ManifestR2Bucket } from '../../../db/shared/virtual-source-store'

export interface RemovedCell {
  cellId: string
  /** The verse address the cell carried, when it had one. USFM exports by this;
   *  it is null for every non-scripture format and for a cell added in-app. */
  canonicalRef: string | null
  /** The create payload's `metadata`, verbatim and unparsed. docx/pptx read
   *  `aquillaImport.sourceLocator` out of it — that shape is the CLIENT's
   *  (src/lib/export/import-locators.ts) and deliberately stays there rather
   *  than being decoded here. */
  metadata: Record<string, unknown> | null
}

/** A `source.cell.create` payload, as far as this module cares. */
interface CreatePayload {
  canonicalRef?: unknown
  metadata?: unknown
}

function parsePayload(raw: unknown): CreatePayload | null {
  // `events.payload` is TEXT, but a driver may hand it back already parsed.
  // Normalize rather than assuming either, the way isUserInsertedCell does.
  try {
    if (raw == null) return null
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    return typeof value === 'object' && value !== null ? (value as CreatePayload) : null
  } catch {
    return null
  }
}

/**
 * Every source cell this file has lost, with where it used to sit.
 *
 * Returns an EMPTY LIST rather than throwing when anything goes wrong. A
 * failure here must not fail the export: the worst outcome of an empty list is
 * today's behaviour, where a removed line keeps the client's original text,
 * while a thrown error would take a whole download with it.
 *
 * Cost: deletes are rare, so the driving scan is small even though migration
 * 0081 dropped the per-cell events index — the outer query uses the
 * `(project_id, file_id, …)` prefix of `idx_events_file_seq`, and the payload
 * lookup runs only for ids that survived the live-row check.
 */
export async function removedCellsForFile(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  r2?: ManifestR2Bucket,
): Promise<RemovedCell[]> {
  try {
    const deleted = await db
      .prepare(
        `SELECT DISTINCT cell_id
           FROM events
          WHERE project_id = ? AND file_id = ? AND kind = 'source.cell.delete'
            AND cell_id IS NOT NULL`,
      )
      .bind(projectId, fileId)
      .all<{ cell_id: string }>()

    const candidates = (deleted.results ?? []).map((r) => r.cell_id).filter(Boolean)
    if (candidates.length === 0) return []

    const vf = r2 ? await loadVirtualSourceFile(db, r2, projectId, fileId) : null
    let gone: string[]
    if (vf) {
      // On a virtual file, a live cell is in `vf.byCellId`; a deleted cell was
      // tombstoned on its sparse overlay (so it is NOT in `vf.byCellId`).
      gone = candidates.filter((id) => !vf.byCellId.has(id))
    } else {
      // Condition 2. A cell whose source row is still there was not removed —
      // the delete lost its chain slot, or a later create put it back.
      const livePlaceholders = candidates.map(() => '?').join(', ')
      const live = await db
        .prepare(
          `SELECT cell_id
             FROM cells
            WHERE project_id = ? AND file_id = ? AND side = 'source'
              AND tombstoned_at IS NULL
              AND cell_id IN (${livePlaceholders})`,
        )
        .bind(projectId, fileId, ...candidates)
        .all<{ cell_id: string }>()
      const stillThere = new Set((live.results ?? []).map((r) => r.cell_id))
      gone = candidates.filter((id) => !stillThere.has(id))
    }
    if (gone.length === 0) return []

    // Where each one sat. Check `source.cell.create` events first, and fall
    // back to tombstoned/manifest units for virtual files (which had no
    // per-cell `source.cell.create` event on import).
    const createPlaceholders = gone.map(() => '?').join(', ')
    const creates = await db
      .prepare(
        `SELECT cell_id, payload
           FROM events
          WHERE project_id = ? AND file_id = ? AND kind = 'source.cell.create'
            AND cell_id IN (${createPlaceholders})
          ORDER BY server_seq ASC`,
      )
      .bind(projectId, fileId, ...gone)
      .all<{ cell_id: string; payload: unknown }>()

    const byCell = new Map<string, CreatePayload | null>()
    for (const row of creates.results ?? []) byCell.set(row.cell_id, parsePayload(row.payload))

    const tombstonedByCell = vf
      ? new Map(vf.tombstonedRows.map((r) => [r.cell_id, r]))
      : null

    return gone.map((cellId) => {
      const payload = byCell.get(cellId) ?? null
      const tomb = tombstonedByCell?.get(cellId)
      const ref = payload?.canonicalRef ?? tomb?.canonical_ref ?? null
      const meta = payload?.metadata ?? tomb?.metadata ?? null
      return {
        cellId,
        canonicalRef: typeof ref === 'string' && ref !== '' ? ref : null,
        metadata:
          typeof meta === 'object' && meta !== null && !Array.isArray(meta)
            ? (meta as Record<string, unknown>)
            : null,
      }
    })
  } catch {
    return []
  }
}
