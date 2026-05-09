/**
 * Typed access to the edit-keyed `backtranslations` projection.
 *
 * Each row is a back-translation generated from a specific cell version's
 * `text_snapshot`. When the cell's translation moves, prior rows stay as
 * historical context — `getActiveBacktranslation` returns the latest by
 * `cell_version_at`.
 *
 * See DATA_PERSISTENCE_PLAN.md §4.11.
 */

import type { LocalStore } from "./db"

export interface BacktranslationRow {
  id: string
  cell_id: string
  cell_version_at: number
  text_snapshot: string
  back_text: string
  generated_by: string
  generated_at: number
  /** 0 = AI-generated, 1 = user-edited. */
  is_user_edited: number
  seq: number
}

const UPSERT_SQL = `INSERT OR REPLACE INTO backtranslations (
  id, cell_id, cell_version_at, text_snapshot, back_text,
  generated_by, generated_at, is_user_edited, seq
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function upsertBacktranslation(
  store: LocalStore,
  b: BacktranslationRow,
): Promise<void> {
  await store.run(UPSERT_SQL, [
    b.id,
    b.cell_id,
    b.cell_version_at,
    b.text_snapshot,
    b.back_text,
    b.generated_by,
    b.generated_at,
    b.is_user_edited,
    b.seq,
  ])
}

export async function getBacktranslation(
  store: LocalStore,
  id: string,
): Promise<BacktranslationRow | null> {
  const rows = await store.query<BacktranslationRow>(
    "SELECT * FROM backtranslations WHERE id = ?",
    [id],
  )
  return rows[0] ?? null
}

/**
 * Returns the latest back-translation for the cell, ordered by
 * `cell_version_at` descending. UI typically shows this one and offers a
 * timeline of historical entries on demand.
 */
export async function getActiveBacktranslation(
  store: LocalStore,
  cellId: string,
): Promise<BacktranslationRow | null> {
  const rows = await store.query<BacktranslationRow>(
    `SELECT * FROM backtranslations
     WHERE cell_id = ?
     ORDER BY cell_version_at DESC, generated_at DESC
     LIMIT 1`,
    [cellId],
  )
  return rows[0] ?? null
}
