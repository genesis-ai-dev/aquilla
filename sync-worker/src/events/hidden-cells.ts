// AQU-1423: which source cells of this file are PARKED, and where do they sit?
//
// "Hide cell" (AQU-1422) takes a cell out of the translation work without
// deleting anything — the source text, every lane's translation, recordings,
// comments and validations all survive, and "Show cell" brings the row back.
// Hiding only means something if the DELIVERED file honours it, and from an
// exporter's point of view a hidden cell looks exactly like an untranslated one:
// it has no translation to write, so the lossless serializer leaves the client's
// own original words in its place. The hide would be silently undone at export,
// and the parked verse would ship in the source language — which is precisely
// the bug AQU-752 was on the Codex side.
//
// So a hidden cell joins the REMOVALS in the USFM export plan, and the verse
// leaves the file marker and all. Not the overrides: an absent or empty override
// is the serializer's "fall back to the original text" signal, so there is no
// value that could express "emit nothing here".
//
// WHY THIS IS SIMPLER THAN `removed-cells.ts`, WHICH IT SITS BESIDE. A removal
// hard-deletes the projection row, so its only durable record is the events log
// and the two-condition reconstruction that module documents. A hide is a
// COLUMN on a row that is still there: `cells.hidden_at` (migration 0112), on
// the shared source row, NULL when visible. One query over live rows, and no
// chain arbitration to redo — `source.cell.visibility.set` is not
// chain-mutating, so the projection is already the authority.
//
// SOURCE SIDE ONLY, deliberately: hiding is per cell, not per lane, so the flag
// lives on `side = 'source' AND target_lang = ''` and every consumer resolves a
// cell's visibility from there. A target row created AFTER the hide — a
// collaborator's in-flight translation, which must survive — carries no flag of
// its own, and is exactly the row that must not come back at export.

import type { AquillaDb } from '../../../db/shim/postgres'

export interface HiddenCell {
  cellId: string
  /** The verse address the cell carries, when it has one. USFM removes by this;
   *  it is null for a cell added in the app, which was never in the client's
   *  file and so has nothing to remove — that one is dropped from the ADDITIONS
   *  instead (see `usfm-export-plan.ts`). */
  canonicalRef: string | null
}

/**
 * Every source cell of this file that is currently hidden.
 *
 * Returns an EMPTY LIST rather than throwing when anything goes wrong, matching
 * `removedCellsForFile` and for the same reason: the worst outcome of an empty
 * list is today's behaviour, where a parked line keeps the client's original
 * text, while a thrown error would take a whole download with it.
 *
 * That fail-soft path also covers a database that predates migration 0112 — the
 * column is simply absent, the query errors, and the export is unchanged.
 *
 * Cost: one indexed lookup. The partial index migration 0112 adds
 * (`idx_cells_hidden ... WHERE hidden_at IS NOT NULL`) covers exactly this
 * predicate, so a 30k-row Bible file with three parked cells reads three rows.
 */
export async function hiddenCellsForFile(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<HiddenCell[]> {
  try {
    const hidden = await db
      .prepare(
        `SELECT cell_id, canonical_ref
           FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''
            AND hidden_at IS NOT NULL`,
      )
      .bind(projectId, fileId)
      .all<{ cell_id: string; canonical_ref: string | null }>()

    return (hidden.results ?? [])
      .filter((row) => Boolean(row.cell_id))
      .map((row) => ({
        cellId: row.cell_id,
        canonicalRef:
          typeof row.canonical_ref === 'string' && row.canonical_ref !== '' ? row.canonical_ref : null,
      }))
  } catch {
    return []
  }
}
